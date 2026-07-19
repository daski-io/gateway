import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { X402_VERSION } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import { computeRequestHash } from "../auth/envelope.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import {
  issuePaymentRequirements,
  resolveSkillOffer,
} from "./requirements.js";
import { validateProviderQuoteCommitment } from "./providerQuote.js";
import { verifyAndSettle } from "./verify.js";
import type {
  Hex,
  PaymentPayload,
  PaymentRequirementsResponse,
  SettlementResponse,
} from "../types.js";

export interface PurchaseDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
}

function encodePaymentResponse(response: SettlementResponse): string {
  return Buffer.from(JSON.stringify(response)).toString("base64");
}

function decodePaymentHeader(header: string): PaymentPayload | null {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
  } catch {
    return null;
  }
}

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ x402Version: X402_VERSION, error: message });
}

export function createPurchaseRouter(deps: PurchaseDeps): Router {
  const router = Router();

  router.post("/purchase/:tokenId", async (req: Request, res: Response) => {
    let providerTokenId: bigint;
    try {
      providerTokenId = BigInt(String(req.params.tokenId));
    } catch {
      sendError(res, 404, "invalid provider token id");
      return;
    }

    const xPayment = req.header("X-PAYMENT") ?? req.header("x-payment");
    const body = req.body ?? {};
    const skillId = typeof body.skillId === "string" ? body.skillId : undefined;
    const amount = typeof body.amount === "string" ? body.amount : undefined;
    const resource = `${deps.config.publicUrl}/purchase/${providerTokenId.toString()}`;

    // ── Path A: no X-PAYMENT → return 402 with PaymentRequirements ──
    if (!xPayment) {
      const buyerTokenIdRaw = body.buyerTokenId;
      if (buyerTokenIdRaw == null) {
        sendError(res, 400, "buyerTokenId is required");
        return;
      }
      let buyerTokenId: bigint;
      try {
        buyerTokenId = BigInt(buyerTokenIdRaw);
      } catch {
        sendError(res, 400, "buyerTokenId must be a numeric string");
        return;
      }

      // walletAddress is required so the gateway can pre-bake the EIP-712
      // typed-data with the correct `from` field. Wallet-agnostic: any
      // signer that lands on this address will produce a recoverable sig.
      const walletAddressRaw = body.walletAddress;
      if (typeof walletAddressRaw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(walletAddressRaw)) {
        sendError(res, 400, "walletAddress is required (20-byte hex)");
        return;
      }
      const walletAddress = walletAddressRaw.toLowerCase() as Hex;

      if (!skillId) {
        sendError(res, 400, "skillId is required");
        return;
      }
      const serviceArgsRaw = body.serviceArgs;
      if (
        serviceArgsRaw !== undefined &&
        (serviceArgsRaw === null ||
          typeof serviceArgsRaw !== "object" ||
          Array.isArray(serviceArgsRaw))
      ) {
        sendError(res, 400, "serviceArgs must be a JSON object");
        return;
      }
      const serviceArgs =
        (serviceArgsRaw as Record<string, unknown> | undefined) ?? {};
      const provider = deps.cache.get(providerTokenId);
      const offerResult = resolveSkillOffer(
        providerTokenId,
        skillId,
        deps.cache,
        { requireFixedAmount: false },
      );
      if (!provider || !offerResult.ok) {
        sendError(
          res,
          offerResult.ok ? 404 : offerResult.status,
          offerResult.ok
            ? "provider is not whitelisted"
            : offerResult.message,
        );
        return;
      }
      const rawQuote = body.providerQuote;
      const rawQuoteAmount =
        rawQuote && typeof rawQuote === "object"
          ? (rawQuote as Record<string, unknown>).amount
          : undefined;
      if (typeof rawQuoteAmount !== "string") {
        sendError(
          res,
          400,
          "providerQuote is required for every paid purchase. Pass the full " +
            "quote object returned by POST <provider>/quote/:serviceSlug.",
        );
        return;
      }
      const offer = offerResult.offer;
      const validation = await validateProviderQuoteCommitment(rawQuote, {
        skillId,
        serviceArgs,
        amount: rawQuoteAmount,
        expectedSignerAddress: provider.walletAddress,
        expectedChainId: deps.config.chainId,
        expectedTokenAddress: deps.config.usdcAddress,
        expectedServiceSlug: offer.serviceSlug,
        expectedServiceVersion: offer.serviceVersion,
      });
      if (!validation.ok) {
        sendError(res, 400, `invalid providerQuote: ${validation.message}`);
        return;
      }
      const quote = validation.quote;
      if (amount !== undefined) {
        let cap: bigint;
        try {
          cap = BigInt(amount);
        } catch {
          sendError(res, 400, "amount must be a decimal string");
          return;
        }
        if (BigInt(quote.amount) > cap) {
          sendError(
            res,
            409,
            `provider quote ${quote.amount} exceeds amount limit ${amount}`,
          );
          return;
        }
      }

      const result = await issuePaymentRequirements(
        {
          providerTokenId,
          buyerTokenId,
          skillId,
          amount: quote.amount,
          resource,
          walletAddress,
          providerQuote: {
            quoteId: quote.quoteId,
            serviceRef: quote.serviceRef,
            requestHash: quote.requestHash,
            providerSignature: quote.providerSignature,
            amount: quote.amount,
            expiresAt: new Date(quote.expiresAt),
            skillId: quote.skillId,
            serviceSlug: quote.serviceSlug,
            serviceVersion: quote.serviceVersion,
          },
          trustQuotedAmount: true,
        },
        deps.config,
        deps.cache,
        deps.queries,
      );
      if (!result.ok) {
        sendError(res, result.status, result.message);
        return;
      }
      const body402: PaymentRequirementsResponse = {
        x402Version: X402_VERSION,
        legal: result.requirements.extra.daski.legal,
        agentAuthority: result.requirements.extra.daski.agentAuthority,
        purchaseNotice: result.requirements.extra.daski.purchaseNotice,
        accepts: [result.requirements],
      };
      res.status(402).json(body402);
      return;
    }

    // ── Path B: X-PAYMENT present → verify + settle ────────────────
    const payload = decodePaymentHeader(xPayment);
    if (!payload) {
      sendError(res, 400, "X-PAYMENT header is not valid base64 JSON");
      return;
    }

    const serviceRef = payload.serviceRef;
    if (typeof serviceRef !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(serviceRef)) {
      sendError(res, 400, "payload.serviceRef missing or malformed");
      return;
    }

    const challenge = await deps.queries.getChallengeByRef(serviceRef as Hex);
    if (!challenge) {
      sendError(res, 404, "no challenge found for the given serviceRef");
      return;
    }
    if (challenge.providerTokenId !== providerTokenId) {
      sendError(res, 400, "serviceRef does not match providerTokenId in URL");
      return;
    }

    const serviceArgsRaw = body.serviceArgs;
    if (
      serviceArgsRaw === undefined ||
      serviceArgsRaw === null ||
      typeof serviceArgsRaw !== "object" ||
      Array.isArray(serviceArgsRaw)
    ) {
      sendError(res, 400, "serviceArgs is required and must be a JSON object");
      return;
    }
    if (!challenge.quoteRequestHash) {
      sendError(res, 409, "stored challenge is missing its quote requestHash");
      return;
    }
    let requestHash: Hex;
    try {
      requestHash = computeRequestHash(
        serviceArgsRaw as Record<string, unknown>,
      );
    } catch {
      sendError(res, 400, "serviceArgs cannot be canonically encoded");
      return;
    }
    if (requestHash.toLowerCase() !== challenge.quoteRequestHash.toLowerCase()) {
      sendError(res, 409, "serviceArgs do not match the provider quote requestHash");
      return;
    }

    const result = await verifyAndSettle(
      { payload, challenge },
      deps.config,
      deps.reader,
      deps.queries,
    );
    if (!result.ok) {
      res.setHeader("X-PAYMENT-RESPONSE", encodePaymentResponse(result.response));
      sendError(res, result.status, result.message);
      return;
    }

    res.setHeader("X-PAYMENT-RESPONSE", encodePaymentResponse(result.response));
    res.status(200).json({ x402Version: X402_VERSION, settlement: result.response });
  });

  // x402 facilitator advertisement — `kinds` matches the spec; the
  // remaining top-level fields are a Daski extension that lets the skill
  // pick up the canonical EAS / identity registry addresses in one hop.
  router.get("/supported", (_req: Request, res: Response) => {
    const caip2 = `eip155:${deps.config.chainId}`;
    res.json({
      kinds: [
        {
          scheme: "exact",
          network: deps.config.network,
          // §1.2 — CAIP-2 dual-emit for x402 v2 facilitators.
          chainId: caip2,
        },
      ],
      endpoints: {
        verify: "/verify",
        settle: "/settle",
      },
      identityRegistryAddress: deps.config.identityRegistryAddress,
      paymentRouterAddress: deps.config.paymentRouterAddress,
      usdcAddress: deps.config.usdcAddress,
      eas: {
        address: deps.config.easAddress,
        confirmationSchemaUid: deps.config.easConfirmationSchemaUid,
        outcomeSchemaUid: deps.config.easOutcomeSchemaUid,
      },
    });
  });

  return router;
}
