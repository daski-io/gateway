import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import {
  generateServiceRef,
  resolveSkillOffer,
  type SkillOffer,
} from "./requirements.js";
import type { ExternalFacilitatorClient } from "./externalFacilitator.js";
import type { ExactEvmAuthorization, Hex, StoredChallenge } from "../types.js";

/**
 * Bazaar-facing x402 resource routes — one paid HTTP resource per
 * (provider, skill), settled by an EXTERNAL facilitator (CDP).
 *
 * Why this exists: the x402 Bazaar catalogs a resource only when the CDP
 * facilitator itself settles a payment for it. The gateway's own
 * facilitator flow (structured EIP-3009 nonce, X402Adapter settle) is
 * invisible to CDP, so Daski services could never be listed. These routes
 * speak the standard x402 v2 dialect end-to-end:
 *
 *   1. GET/POST without payment  → 402 with spec-shaped `accepts` and the
 *      Bazaar discovery extension (client-chosen nonce, no Daski wiring).
 *   2. Paid retry (PAYMENT-SIGNATURE header) → gateway forwards
 *      verify/settle to the external facilitator. Its settle executes a
 *      bare `transferWithAuthorization` — buyer USDC lands on the
 *      PaymentRouter, unsplit.
 *   3. Gateway submits DirectTransferAdapter.attribute, which runs the
 *      commission split + payment record for the funds that just arrived.
 *
 * Splitting is preserved on-chain; only WHO submits the transfer changed.
 *
 * Buyers on this rail must already hold an ERC-8004 identity: the router
 * requires a non-zero buyerAgentId and external facilitators cannot carry
 * Daski's atomic register-and-settle signature. Unregistered wallets get
 * a 403 pointing at the gasless /register flow BEFORE any funds move.
 */

export interface BazaarDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  facilitator: ExternalFacilitatorClient;
}

// 402 responses must leave the buyer enough signing runway; mirror the
// daski-rail buffer so both rails reject nearly-expired authorizations
// consistently.
const VALID_BEFORE_BUFFER_SEC = 10n;

function isHex42(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}

function isHex66(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
}

interface PaymentCore {
  /** 1 or 2 — echoed back in responses. */
  version: number;
  signature: Hex;
  authorization: ExactEvmAuthorization;
  /** The decoded payload as received — forwarded to the facilitator. */
  raw: Record<string, unknown>;
}

/**
 * Decode + normalize a payment header. Accepts both wire generations:
 *   v2: { x402Version: 2, resource?, accepted?, payload: {signature, authorization}, extensions? }
 *   v1: { x402Version: 1, scheme, network, payload: {signature, authorization} }
 * Returns null when the header is not base64 JSON in either shape.
 */
function decodePaymentHeader(header: string): PaymentCore | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.x402Version === "number" ? obj.x402Version : NaN;
  if (version !== 1 && version !== 2) return null;

  const inner = obj.payload;
  if (!inner || typeof inner !== "object") return null;
  const signature = (inner as Record<string, unknown>).signature;
  const auth = (inner as Record<string, unknown>).authorization;
  if (typeof signature !== "string" || !auth || typeof auth !== "object") {
    return null;
  }
  const a = auth as Record<string, unknown>;
  if (
    !isHex42(a.from) ||
    !isHex42(a.to) ||
    !isHex66(a.nonce) ||
    typeof a.value !== "string" ||
    typeof a.validAfter !== "string" ||
    typeof a.validBefore !== "string"
  ) {
    return null;
  }
  return {
    version,
    signature: signature as Hex,
    authorization: {
      from: a.from,
      to: a.to,
      value: a.value,
      validAfter: a.validAfter,
      validBefore: a.validBefore,
      nonce: a.nonce,
    },
    raw: obj,
  };
}

/** Bazaar discovery extension declared on every 402 (x402 v2 shape). */
function buildBazaarExtension(offer: SkillOffer, config: Config) {
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "POST",
          bodyType: "json",
          // The purchase itself takes no request body; task dispatch is a
          // follow-up A2A/MCP call quoting the returned paymentId.
          body: {},
        },
        output: {
          type: "json",
          example: {
            x402Version: 2,
            receipt: {
              paymentId: "42",
              serviceRef: "0x…",
              skillId: offer.skillId,
              providerA2AUrl: offer.providerA2AUrl,
              next: {
                mcp: `${config.publicUrl}${config.mcpPath}`,
                skillDocs: `${config.publicUrl}/skill.md`,
              },
            },
          },
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: { type: "object", properties: {}, additionalProperties: true },
          output: {
            type: "object",
            properties: {
              x402Version: { type: "integer" },
              receipt: { type: "object" },
            },
          },
        },
      },
    },
  };
}

/** Spec-shaped x402 v2 402 body with the Bazaar extension attached. */
function buildPaymentRequired(
  offer: SkillOffer,
  config: Config,
  resourceUrl: string,
  error?: string,
) {
  return {
    x402Version: 2,
    error: error ?? "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${config.chainId}`,
        amount: offer.amount.toString(),
        asset: config.usdcAddress,
        payTo: config.paymentRouterAddress,
        maxTimeoutSeconds: config.challengeTtlSeconds,
        extra: { name: config.usdcName, version: config.usdcVersion },
      },
    ],
    extensions: buildBazaarExtension(offer, config),
  };
}

/**
 * Requirements object for the facilitator body, shaped per the payload's
 * wire generation. v1 facilitators (x402.org) want the flat v1 shape with
 * `maxAmountRequired` + `resource`; v2 (CDP) wants `amount` + CAIP-2.
 */
function buildFacilitatorRequirements(
  version: number,
  offer: SkillOffer,
  config: Config,
  resourceUrl: string,
): Record<string, unknown> {
  if (version === 1) {
    return {
      scheme: "exact",
      network: config.network,
      maxAmountRequired: offer.amount.toString(),
      resource: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
      payTo: config.paymentRouterAddress,
      maxTimeoutSeconds: config.challengeTtlSeconds,
      asset: config.usdcAddress,
      extra: { name: config.usdcName, version: config.usdcVersion },
    };
  }
  return {
    scheme: "exact",
    network: `eip155:${config.chainId}`,
    amount: offer.amount.toString(),
    asset: config.usdcAddress,
    payTo: config.paymentRouterAddress,
    maxTimeoutSeconds: config.challengeTtlSeconds,
    extra: { name: config.usdcName, version: config.usdcVersion },
  };
}

/**
 * The payload forwarded to the facilitator. Bazaar indexing keys on
 * `paymentPayload.resource`, so inject the resource block when the client
 * omitted it (the extension spec allows appending, never overwriting).
 */
function buildForwardedPayload(
  core: PaymentCore,
  offer: SkillOffer,
  resourceUrl: string,
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = { ...core.raw };
  if (core.version === 2 && forwarded.resource === undefined) {
    forwarded.resource = {
      url: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
    };
  }
  return forwarded;
}

function receiptBody(
  version: number,
  config: Config,
  offer: Pick<SkillOffer, "skillId" | "providerA2AUrl">,
  fields: {
    paymentId: string;
    serviceRef: Hex;
    providerTokenId: string;
    buyerTokenId: string;
    amount: string;
    settlementTransaction: string | null;
    attributionTransaction: string | null;
  },
) {
  return {
    x402Version: version,
    receipt: {
      ...fields,
      skillId: offer.skillId,
      providerA2AUrl: offer.providerA2AUrl,
      next: {
        description:
          "Payment settled and attributed on-chain. Dispatch the purchased " +
          "task to the provider (Daski MCP daski_submit_task, or direct A2A) " +
          "quoting paymentId.",
        mcp: `${config.publicUrl}${config.mcpPath}`,
        skillDocs: `${config.publicUrl}/skill.md`,
      },
    },
  };
}

function setSettlementHeaders(
  res: Response,
  settlement: Record<string, unknown>,
) {
  const encoded = Buffer.from(JSON.stringify(settlement)).toString("base64");
  // v2 transport header plus the v1 legacy name — clients read whichever
  // generation they speak.
  res.setHeader("PAYMENT-RESPONSE", encoded);
  res.setHeader("X-PAYMENT-RESPONSE", encoded);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "23505"
  );
}

export function createBazaarRouter(deps: BazaarDeps): Router {
  const { config, cache, queries, reader, facilitator } = deps;
  const router = Router();

  const handler = async (req: Request, res: Response) => {
    let providerTokenId: bigint;
    try {
      providerTokenId = BigInt(String(req.params.tokenId));
    } catch {
      res.status(404).json({ x402Version: 2, error: "invalid provider token id" });
      return;
    }
    const skillId = String(req.params.skillId ?? "");

    const resolved = resolveSkillOffer(providerTokenId, skillId, cache);
    if (!resolved.ok) {
      res
        .status(resolved.status)
        .json({ x402Version: 2, error: `${resolved.code}: ${resolved.message}` });
      return;
    }
    const offer = resolved.offer;
    const resourceUrl = `${config.publicUrl}/x402/services/${providerTokenId.toString()}/${skillId}`;

    const paymentHeader =
      req.header("payment-signature") ??
      req.header("payment") ??
      req.header("x-payment");

    // ── Path A: no payment → 402 with requirements + Bazaar extension ──
    if (!paymentHeader) {
      res.status(402).json(buildPaymentRequired(offer, config, resourceUrl));
      return;
    }

    // ── Path B: paid retry ──────────────────────────────────────────────
    const core = decodePaymentHeader(paymentHeader);
    if (!core) {
      res.status(400).json({
        x402Version: 2,
        error:
          "payment header is not base64-encoded x402 v1/v2 JSON with an " +
          "exact-scheme EVM authorization",
      });
      return;
    }
    const auth = core.authorization;
    const from = auth.from.toLowerCase() as Hex;
    const authNonce = auth.nonce.toLowerCase() as Hex;

    // Static checks against the advertised offer. The external facilitator
    // re-verifies everything (including the signature); failing fast here
    // gives the client a spec-shaped 402 with the requirements attached.
    if (auth.to.toLowerCase() !== config.paymentRouterAddress.toLowerCase()) {
      res.status(402).json(
        buildPaymentRequired(
          offer,
          config,
          resourceUrl,
          "authorization `to` must be the advertised payTo (PaymentRouter)",
        ),
      );
      return;
    }
    let value: bigint;
    try {
      value = BigInt(auth.value);
    } catch {
      res.status(400).json({ x402Version: 2, error: "authorization value must be a decimal string" });
      return;
    }
    if (value !== offer.amount) {
      res.status(402).json(
        buildPaymentRequired(
          offer,
          config,
          resourceUrl,
          `authorization value ${auth.value} does not match required amount ${offer.amount.toString()}`,
        ),
      );
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let validAfter: bigint;
    let validBefore: bigint;
    try {
      validAfter = BigInt(auth.validAfter);
      validBefore = BigInt(auth.validBefore);
    } catch {
      res.status(400).json({ x402Version: 2, error: "authorization time bounds must be decimal strings" });
      return;
    }
    if (validAfter > nowSec || validBefore <= nowSec + VALID_BEFORE_BUFFER_SEC) {
      res.status(402).json(
        buildPaymentRequired(
          offer,
          config,
          resourceUrl,
          "authorization is not currently valid (validAfter/validBefore window)",
        ),
      );
      return;
    }

    // Idempotency: the client-chosen (wallet, nonce) pair is the only key
    // a standard x402 retry carries. Resolve it before anything else so a
    // replay of an already-settled payload returns the original receipt
    // instead of double-charging or erroring on a consumed nonce.
    let challenge: StoredChallenge | null =
      await queries.getChallengeByWalletAndNonce(from, authNonce);
    if (challenge) {
      const mismatch =
        challenge.providerTokenId !== providerTokenId ||
        challenge.skillId !== skillId ||
        challenge.amount !== value;
      if (mismatch) {
        res.status(409).json({
          x402Version: core.version,
          error:
            "this authorization nonce is already bound to a different " +
            "Daski purchase; sign a fresh authorization",
        });
        return;
      }
      if (challenge.status === "paid" && challenge.paymentId != null) {
        setSettlementHeaders(res, {
          success: true,
          transaction: challenge.externalSettleTx ?? challenge.transactionHash ?? "",
          network: config.network,
          payer: from,
        });
        res.status(200).json(
          receiptBody(core.version, config, offer, {
            paymentId: challenge.paymentId.toString(),
            serviceRef: challenge.serviceRef,
            providerTokenId: challenge.providerTokenId.toString(),
            buyerTokenId: challenge.buyerTokenId.toString(),
            amount: challenge.amount.toString(),
            settlementTransaction: challenge.externalSettleTx,
            attributionTransaction: challenge.transactionHash,
          }),
        );
        return;
      }
      if (challenge.status === "expired") {
        res.status(410).json({
          x402Version: core.version,
          error: "the pending purchase for this authorization has expired; sign a fresh authorization",
        });
        return;
      }
    }

    // Registration gate — BEFORE any funds move. The router requires a
    // non-zero buyerAgentId at attribution time and this rail has no
    // atomic-register path (external facilitators can't carry the
    // RegisterAgent signature), so reject unregistered wallets while the
    // authorization is still unspent.
    let buyerAgentId: bigint;
    try {
      buyerAgentId = await reader.agentOfWallet(from);
    } catch (err) {
      res.status(503).json({
        x402Version: core.version,
        error: `unable to resolve buyer identity: ${(err as Error).message}`,
      });
      return;
    }
    if (buyerAgentId === 0n) {
      res.status(403).json({
        x402Version: core.version,
        error: "buyer_not_registered",
        message:
          "This wallet has no Daski (ERC-8004) identity. Register first — " +
          "gasless: GET /register-prep then POST /register on this gateway, " +
          "or the daski_register_agent MCP tool — then retry the payment.",
        register: {
          prep: `${config.publicUrl}/register-prep`,
          submit: `${config.publicUrl}/register`,
          mcp: `${config.publicUrl}${config.mcpPath}`,
        },
      });
      return;
    }

    const forwardedPayload = buildForwardedPayload(core, offer, resourceUrl);
    const facilitatorRequirements = buildFacilitatorRequirements(
      core.version,
      offer,
      config,
      resourceUrl,
    );
    const facilitatorBody = {
      x402Version: core.version,
      paymentPayload: forwardedPayload,
      paymentRequirements: facilitatorRequirements,
    };

    // Fresh payment (or a retry that crashed before the external settle):
    // verify with the external facilitator before creating/keeping state.
    const needsExternalSettle = !challenge?.externalSettleTx;
    if (needsExternalSettle) {
      let verify;
      try {
        verify = await facilitator.verify(facilitatorBody);
      } catch (err) {
        res.status(502).json({
          x402Version: core.version,
          error: (err as Error).message,
        });
        return;
      }
      if (!verify.isValid) {
        res.status(402).json(
          buildPaymentRequired(
            offer,
            config,
            resourceUrl,
            `external facilitator rejected the payment: ${verify.invalidReason ?? "invalid"}`,
          ),
        );
        return;
      }

      if (!challenge) {
        const serviceRef = generateServiceRef(skillId);
        const expiresAt = new Date(
          Date.now() + config.challengeTtlSeconds * 1000,
        );
        try {
          await queries.insertChallenge({
            serviceRef,
            providerTokenId,
            buyerTokenId: buyerAgentId,
            amount: offer.amount,
            skillId,
            serviceSlug: offer.serviceSlug,
            serviceVersion: offer.serviceVersion,
            serviceId: offer.serviceId,
            providerA2AUrl: offer.providerA2AUrl,
            walletAddress: from,
            expiresAt,
            rail: "external",
            authNonce,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // A concurrent request with the same payload won the insert.
            res.status(409).json({
              x402Version: core.version,
              error: "this payment is already being processed; retry shortly",
            });
            return;
          }
          throw err;
        }
        challenge = await queries.getChallengeByWalletAndNonce(from, authNonce);
        if (!challenge) {
          res.status(500).json({
            x402Version: core.version,
            error: "challenge row vanished after insert",
          });
          return;
        }
      }

      let settle;
      try {
        settle = await facilitator.settle(facilitatorBody);
      } catch (err) {
        // Unknown whether the facilitator broadcast before failing. The
        // challenge stays pending; a retry re-runs verify (which reports
        // a consumed nonce if the settle actually landed) — no funds are
        // lost either way, and the authorization can't be double-spent.
        res.status(502).json({
          x402Version: core.version,
          error: (err as Error).message,
        });
        return;
      }
      if (!settle.success) {
        res.status(402).json(
          buildPaymentRequired(
            offer,
            config,
            resourceUrl,
            `external facilitator settle failed: ${settle.errorReason ?? "unknown"}`,
          ),
        );
        return;
      }
      const settleTx = (settle.transaction ?? "") as Hex;
      if (settleTx) {
        await queries.recordChallengeExternallySettled(
          challenge.serviceRef,
          settleTx,
        );
        challenge = { ...challenge, externalSettleTx: settleTx };
      }
    }

    // Funds are on the router. Attribute: run the split + payment record.
    let attribution;
    try {
      attribution = await reader.attributeDirectTransfer({
        providerAgentId: providerTokenId,
        serviceId: offer.serviceId,
        amount: offer.amount,
        serviceRef: challenge!.serviceRef,
        from,
        authNonce,
      });
    } catch (err) {
      // The buyer HAS paid (external settle succeeded); only the split is
      // pending. Persisted external_settle_tx makes this retryable: the
      // same request skips the external settle and lands back here.
      res.status(502).json({
        x402Version: core.version,
        error: "attribution_pending",
        message:
          `payment settled on-chain but the commission split has not run ` +
          `yet (${(err as Error).message}). Retry this exact request — ` +
          `the gateway resumes at attribution without re-charging.`,
        settlementTransaction: challenge!.externalSettleTx,
        serviceRef: challenge!.serviceRef,
      });
      return;
    }

    const event = attribution.event;
    await queries.recordChallengePaid(
      challenge!.serviceRef,
      event.paymentId,
      attribution.transactionHash,
      event.buyerAgentId,
    );
    // Mirror into chain_events so /activity reflects the purchase
    // immediately (same as the daski-rail settle path).
    await queries.upsertChainEvent({
      paymentId: event.paymentId,
      txHash: attribution.transactionHash,
      blockNumber: 0n,
      serviceId: event.serviceId,
      buyerAgentId: event.buyerAgentId,
      providerAgentId: event.providerAgentId,
      amountAtomic: event.totalAmount,
      settledAt: new Date(),
      outcomeCode: null,
      confirmationCode: 0,
      fulfillmentSeconds: null,
      refundedAtomic: 0n,
    });

    setSettlementHeaders(res, {
      success: true,
      transaction: challenge!.externalSettleTx ?? attribution.transactionHash,
      network: config.network,
      payer: from,
    });
    res.status(200).json(
      receiptBody(core.version, config, offer, {
        paymentId: event.paymentId.toString(),
        serviceRef: challenge!.serviceRef,
        providerTokenId: providerTokenId.toString(),
        buyerTokenId: event.buyerAgentId.toString(),
        amount: event.totalAmount.toString(),
        settlementTransaction: challenge!.externalSettleTx,
        attributionTransaction: attribution.transactionHash,
      }),
    );
  };

  // GET serves crawlers + human inspection; POST is the declared Bazaar
  // method (bodyType json, body unused for the purchase itself).
  router.get("/x402/services/:tokenId/:skillId", handler);
  router.post("/x402/services/:tokenId/:skillId", handler);

  return router;
}
