import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { X402_VERSION } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import { issuePaymentRequirements } from "./requirements.js";
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

      const result = await issuePaymentRequirements(
        { providerTokenId, buyerTokenId, skillId, amount, resource, walletAddress },
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
      // Top-level legacy fields: `chainId` is numeric (existing clients),
      // `chainIdCaip2` is the CAIP-2 string. Inside `kinds[]`, `chainId`
      // is the CAIP-2 string (matching the v2 schema where the kind entry
      // replaces v1's `network` enum).
      chainId: deps.config.chainId,
      chainIdCaip2: caip2,
      network: deps.config.network,
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
