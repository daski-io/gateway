import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import { computeRequestHash } from "../auth/envelope.js";
import { resolveSkillOffer, type SkillOffer } from "./requirements.js";
import {
  fetchProviderQuote,
  validateProviderQuoteCommitment,
  type ProviderQuoteCommitment,
  type ProviderQuoteResult,
} from "./providerQuote.js";
import type { ExternalFacilitatorClient } from "./externalFacilitator.js";
import type { Fetcher } from "../mcp/a2a.js";
import type { ExactEvmAuthorization, Hex, StoredChallenge } from "../types.js";
import { buildPurchaseLegalContext } from "../legal/purchase.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import { publicErrorMessage } from "../util/errorWrap.js";

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
 *   1. GET/POST without payment  → the gateway QUOTES the provider
 *      (signed quote commitment, audit 1.1) and returns a 402 whose
 *      amount is the quoted price — quote == charge — with the Bazaar
 *      discovery extension attached. `body.serviceArgs` feeds the quote;
 *      the quote commits to their canonical hash, so the eventual task
 *      must be submitted with exactly the same serviceArgs.
 *   2. Paid retry (PAYMENT-SIGNATURE header) → a fresh quote is taken,
 *      the challenge adopts the QUOTE's serviceRef
 *      (keccak256(canonicalJson(signedQuotePayload))) and persists
 *      quoteId + quoteSignature, then the gateway forwards verify/settle
 *      to the external facilitator. Its settle executes a bare
 *      `transferWithAuthorization` — buyer USDC lands on the
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
  /** SSRF-safe fetcher for the provider's /quote endpoint. */
  quoteFetch: Fetcher;
  quoteTimeoutMs?: number;
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

/** Body-supplied serviceArgs (the quote commits to their canonical hash). */
function serviceArgsFrom(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body && typeof body === "object") {
    const args = (body as Record<string, unknown>).serviceArgs;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
  }
  return {};
}

/** Seconds the buyer realistically has to sign + settle + submit. */
function boundedTimeoutSeconds(
  config: Config,
  quote: ProviderQuoteCommitment,
): number | null {
  const quoteSeconds = Math.floor((Date.parse(quote.expiresAt) - Date.now()) / 1000);
  if (quoteSeconds < 15) return null;
  return Math.min(config.challengeTtlSeconds, quoteSeconds);
}

function acceptedProviderQuote(core: PaymentCore): unknown {
  const accepted = core.raw.accepted;
  if (!accepted || typeof accepted !== "object") return undefined;
  const extra = (accepted as Record<string, unknown>).extra;
  if (!extra || typeof extra !== "object") return undefined;
  const daski = (extra as Record<string, unknown>).daski;
  if (!daski || typeof daski !== "object") return undefined;
  return (daski as Record<string, unknown>).providerQuote;
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
          // serviceArgs feed the provider quote AND the eventual task —
          // the signed quote commits to their canonical hash, so the task
          // must be submitted with exactly the same values.
          body: { serviceArgs: {} },
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
              quote: { quoteId: "…", quoteSignature: "0x…" },
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
          input: {
            type: "object",
            properties: {
              serviceArgs: {
                type: "object",
                description:
                  "Skill-specific arguments (see the provider Agent Card " +
                  "skill inputSchema). The provider's signed quote commits " +
                  "to these — submit the task with identical values.",
              },
            },
            additionalProperties: true,
          },
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
  amount: bigint,
  config: Config,
  resourceUrl: string,
  maxTimeoutSeconds: number,
  purchaseLegal: PurchaseLegalContext,
  providerQuote?: ProviderQuoteCommitment,
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
    legal: purchaseLegal.legal,
    agentAuthority: purchaseLegal.agentAuthority,
    purchaseNotice: purchaseLegal.purchaseNotice,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${config.chainId}`,
        amount: amount.toString(),
        asset: config.usdcAddress,
        payTo: config.paymentRouterAddress,
        maxTimeoutSeconds,
        extra: {
          name: config.usdcName,
          version: config.usdcVersion,
          daski: {
            ...(providerQuote ? { providerQuote } : {}),
            ...purchaseLegal,
          },
        },
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
  amount: bigint,
  config: Config,
  resourceUrl: string,
  maxTimeoutSeconds: number,
): Record<string, unknown> {
  if (version === 1) {
    return {
      scheme: "exact",
      network: config.network,
      maxAmountRequired: amount.toString(),
      resource: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
      payTo: config.paymentRouterAddress,
      maxTimeoutSeconds,
      asset: config.usdcAddress,
      extra: { name: config.usdcName, version: config.usdcVersion },
    };
  }
  return {
    scheme: "exact",
    network: `eip155:${config.chainId}`,
    amount: amount.toString(),
    asset: config.usdcAddress,
    payTo: config.paymentRouterAddress,
    maxTimeoutSeconds,
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
    quoteId: string | null;
    quoteSignature: Hex | null;
    serviceArgs: Record<string, unknown>;
  },
) {
  const { quoteId, quoteSignature, serviceArgs, ...rest } = fields;
  return {
    x402Version: version,
    receipt: {
      ...rest,
      skillId: offer.skillId,
      providerA2AUrl: offer.providerA2AUrl,
      // The provider's signed quote credentials. daski_submit_task
      // injects them automatically; direct-A2A buyers must copy them
      // into the task's daski metadata (quoteId / quoteSignature).
      ...(quoteId && quoteSignature
        ? { quote: { quoteId, quoteSignature } }
        : {}),
      // Echo of the serviceArgs this purchase was quoted with — the
      // provider's quote commits to their canonical hash.
      serviceArgs,
      next: {
        description:
          "Payment settled and attributed on-chain. Dispatch the purchased " +
          "task to the provider (Daski MCP daski_submit_task, or direct A2A) " +
          "quoting paymentId — and with EXACTLY the serviceArgs echoed " +
          "above: the provider validates them against the signed quote. " +
          "Submit promptly; the quote commitment expires ~2 minutes after " +
          "issuance.",
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
  res.setHeader("PAYMENT-RESPONSE", encoded);
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

  /** Quote the provider; map failures onto HTTP responses. */
  async function quoteOrRespond(
    res: Response,
    offer: SkillOffer,
    skillId: string,
    serviceArgs: Record<string, unknown>,
  ): Promise<{ amount: bigint; quote: ProviderQuoteCommitment } | null> {
    const provider = cache.get(offer.providerTokenId);
    if (!provider) {
      res.status(404).json({
        x402Version: 2,
        error: "provider_not_found: provider is not in the discovery cache",
      });
      return null;
    }
    let result: ProviderQuoteResult;
    result = await fetchProviderQuote({
      providerA2AUrl: offer.providerA2AUrl,
      skillId,
      serviceArgs,
      expectedSignerAddress: provider.walletAddress,
      expectedChainId: config.chainId,
      expectedTokenAddress: config.usdcAddress,
      expectedServiceSlug: offer.serviceSlug,
      expectedServiceVersion: offer.serviceVersion,
      fetchFn: deps.quoteFetch,
      timeoutMs: deps.quoteTimeoutMs,
    });
    if (!result.ok) {
      if (result.code === "quote_validation_failed") {
        // Buyer-actionable: their serviceArgs don't price. 422 mirrors
        // the provider's own semantics (correct the input and retry).
        res.status(422).json({
          x402Version: 2,
          error: "quote_validation_failed: fix body.serviceArgs and retry",
          validationErrors: result.errors ?? [],
        });
        return null;
      }
      res.status(502).json({
        x402Version: 2,
        error: `${result.code}: ${result.message}`,
      });
      return null;
    }
    let amount: bigint;
    try {
      amount = BigInt(result.amount);
    } catch {
      res.status(502).json({
        x402Version: 2,
        error: "quote_malformed: provider quote amount is not numeric",
      });
      return null;
    }
    if (amount <= 0n || !result.paymentRequired) {
      // Free skills aren't purchasable resources.
      res.status(404).json({
        x402Version: 2,
        error: "skill_is_free: nothing to purchase for these serviceArgs",
      });
      return null;
    }
    if (!result.quote) {
      // A paid quote without a signed commitment cannot be settled on
      // this rail: the provider would reject the task at submit time,
      // AFTER funds were captured. Refuse while nothing has moved.
      res.status(503).json({
        x402Version: 2,
        error:
          "quote_commitment_missing: provider issued no signed quote " +
          "commitment (pre-audit-1.1 build); this resource cannot settle " +
          "safely until the provider is upgraded",
      });
      return null;
    }
    if (boundedTimeoutSeconds(config, result.quote) === null) {
      res.status(409).json({
        x402Version: 2,
        error: "quote_expired: provider quote has less than 15 seconds remaining",
      });
      return null;
    }
    return { amount, quote: result.quote };
  }

  const handler = async (req: Request, res: Response) => {
    let providerTokenId: bigint;
    try {
      providerTokenId = BigInt(String(req.params.tokenId));
    } catch {
      res.status(404).json({ x402Version: 2, error: "invalid provider token id" });
      return;
    }
    const skillId = String(req.params.skillId ?? "");
    const paymentHeader =
      req.header("payment-signature") ??
      req.header("payment") ??
      req.header("x-payment");

    const resolved = resolveSkillOffer(providerTokenId, skillId, cache, {
      requireFixedAmount: false,
    });
    let offer: SkillOffer;
    let recoveryChallenge: StoredChallenge | null = null;
    if (resolved.ok) {
      offer = resolved.offer;
    } else {
      let persisted: StoredChallenge | null = null;
      if (paymentHeader) {
        const decoded = decodePaymentHeader(paymentHeader);
        if (decoded) {
          persisted = await queries.getChallengeByWalletAndNonce(
            decoded.authorization.from.toLowerCase() as Hex,
            decoded.authorization.nonce.toLowerCase() as Hex,
          );
        }
      }
      if (
        !persisted ||
        persisted.providerTokenId !== providerTokenId ||
        persisted.skillId !== skillId
      ) {
        res.status(resolved.status).json({
          x402Version: 2,
          error: `${resolved.code}: ${resolved.message}`,
        });
        return;
      }
      recoveryChallenge = persisted;
      // Recovery after funds moved must not depend on mutable Agent Card
      // data. Resume with the immutable identity stored on the challenge.
      offer = {
        providerTokenId: persisted.providerTokenId,
        skillId,
        amount: persisted.amount,
        serviceSlug: persisted.serviceSlug,
        serviceVersion: persisted.serviceVersion,
        serviceId: persisted.serviceId,
        providerA2AUrl: persisted.providerA2AUrl,
        description: `Daski service ${skillId}`,
      };
    }
    const resourceUrl = `${config.publicUrl}/x402/services/${providerTokenId.toString()}/${skillId}`;
    const providerLegal = cache.get(providerTokenId)?.providerLegal;
    const purchaseLegal = providerLegal
      ? buildPurchaseLegalContext(config, providerLegal)
      : null;
    if (!purchaseLegal && !recoveryChallenge) {
      res.status(422).json({
        x402Version: 2,
        error:
          "provider_legal_metadata_invalid: provider legal metadata is missing or invalid",
      });
      return;
    }
    const serviceArgs = serviceArgsFrom(req);
    let serviceArgsHash: Hex;
    try {
      serviceArgsHash = computeRequestHash(serviceArgs);
    } catch (error) {
      res.status(400).json({
        x402Version: 2,
        error: `serviceArgs cannot be canonically hashed: ${(error as Error).message}`,
      });
      return;
    }

    // GET is catalog discovery only: it has no request body and therefore
    // cannot produce a quote bound to argument-requiring skills. A fixed
    // card price is sufficient for crawlers; the actual purchase starts
    // with POST so its 402 can carry the signed, argument-bound quote.
    if (!paymentHeader) {
      if (!purchaseLegal) {
        res.status(422).json({
          x402Version: 2,
          error:
            "provider_legal_metadata_invalid: provider legal metadata is missing or invalid",
        });
        return;
      }
      if (req.method === "GET") {
        if (offer.amount === null) {
          res.status(422).json({
            x402Version: 2,
            error:
              "serviceArgs_required: POST this resource with body.serviceArgs " +
              "to obtain an argument-bound live quote",
          });
          return;
        }
        res.status(402).json(
          buildPaymentRequired(
            offer,
            offer.amount,
            config,
            resourceUrl,
            config.challengeTtlSeconds,
            purchaseLegal,
          ),
        );
        return;
      }
      const quoted = await quoteOrRespond(res, offer, skillId, serviceArgs);
      if (!quoted) return;
      const timeout = boundedTimeoutSeconds(config, quoted.quote);
      if (timeout === null) {
        res.status(409).json({
          x402Version: 2,
          error: "quote_expired: request a fresh provider quote",
        });
        return;
      }
      res.status(402).json(
        buildPaymentRequired(
          offer,
          quoted.amount,
          config,
          resourceUrl,
          timeout,
          purchaseLegal,
          quoted.quote,
        ),
      );
      return;
    }

    if (req.method === "GET") {
      res.status(405).json({
        x402Version: 2,
        error: "paid requests must use POST with the quoted serviceArgs body",
      });
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

    // Static checks that don't depend on pricing. The external facilitator
    // re-verifies everything (including the signature).
    if (auth.to.toLowerCase() !== config.paymentRouterAddress.toLowerCase()) {
      res.status(400).json({
        x402Version: core.version,
        error: "authorization `to` must be the advertised payTo (PaymentRouter)",
      });
      return;
    }
    let value: bigint;
    try {
      value = BigInt(auth.value);
    } catch {
      res.status(400).json({ x402Version: core.version, error: "authorization value must be a decimal string" });
      return;
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    let validAfter: bigint;
    let validBefore: bigint;
    try {
      validAfter = BigInt(auth.validAfter);
      validBefore = BigInt(auth.validBefore);
    } catch {
      res.status(400).json({ x402Version: core.version, error: "authorization time bounds must be decimal strings" });
      return;
    }
    if (validAfter > nowSec || validBefore <= nowSec + VALID_BEFORE_BUFFER_SEC) {
      res.status(400).json({
        x402Version: core.version,
        error: "authorization is not currently valid (validAfter/validBefore window)",
      });
      return;
    }

    let challenge: StoredChallenge | null =
      await queries.getChallengeByWalletAndNonce(from, authNonce);
    let quoted: { amount: bigint; quote: ProviderQuoteCommitment } | null = null;
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
      if (
        !challenge.quoteRequestHash ||
        challenge.quoteRequestHash.toLowerCase() !== serviceArgsHash.toLowerCase()
      ) {
        res.status(409).json({
          x402Version: core.version,
          error:
            "serviceArgs differ from the request bound to this authorization's " +
            "provider quote",
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
          receiptBody(core.version, config, {
            skillId: challenge.skillId ?? skillId,
            providerA2AUrl: challenge.providerA2AUrl,
          }, {
            paymentId: challenge.paymentId.toString(),
            serviceRef: challenge.serviceRef,
            providerTokenId: challenge.providerTokenId.toString(),
            buyerTokenId: challenge.buyerTokenId.toString(),
            amount: challenge.amount.toString(),
            settlementTransaction: challenge.externalSettleTx,
            attributionTransaction: challenge.transactionHash,
            quoteId: challenge.quoteId,
            quoteSignature: challenge.quoteSignature,
            serviceArgs,
          }),
        );
        return;
      }
      if (challenge.status === "expired" && !challenge.externalSettleTx) {
        res.status(410).json({
          x402Version: core.version,
          error:
            "the pending purchase for this authorization has expired; " +
            "request a fresh 402 (fresh quote) and sign a new authorization",
        });
        return;
      }
    }

    let buyerAgentId = challenge?.buyerTokenId ?? 0n;
    if (!challenge) {
      if (!purchaseLegal) {
        res.status(409).json({
          x402Version: core.version,
          error: "payment_recovery_state_missing",
          message:
            "The persisted purchase state disappeared during recovery. No new " +
            "payment requirements were issued because the Provider's legal " +
            "metadata is currently invalid.",
        });
        return;
      }
      try {
        buyerAgentId = await reader.agentOfWallet(from);
      } catch (err) {
        res.status(503).json({
          x402Version: core.version,
          error: publicErrorMessage(
            "bazaar.agentOfWallet",
            err,
            "unable to resolve buyer identity",
          ),
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

      if (core.version === 2) {
        const rawQuote = acceptedProviderQuote(core);
        const rawAmount =
          rawQuote && typeof rawQuote === "object"
            ? (rawQuote as Record<string, unknown>).amount
            : undefined;
        const provider = cache.get(providerTokenId);
        const validation =
          provider && typeof rawAmount === "string"
            ? await validateProviderQuoteCommitment(rawQuote, {
                skillId,
                serviceArgs,
                amount: rawAmount,
                expectedSignerAddress: provider.walletAddress,
                expectedChainId: config.chainId,
                expectedTokenAddress: config.usdcAddress,
                expectedServiceSlug: offer.serviceSlug,
                expectedServiceVersion: offer.serviceVersion,
              })
            : { ok: false as const, message: "accepted quote is missing" };
        if (!validation.ok) {
          const replacement = await quoteOrRespond(
            res,
            offer,
            skillId,
            serviceArgs,
          );
          if (!replacement) return;
          const timeout = boundedTimeoutSeconds(config, replacement.quote);
          if (timeout === null) {
            res.status(409).json({
              x402Version: core.version,
              error: "quote_expired: request a fresh provider quote",
            });
            return;
          }
          res.status(402).json(
            buildPaymentRequired(
              offer,
              replacement.amount,
              config,
              resourceUrl,
              timeout,
              purchaseLegal,
              replacement.quote,
              `payment header does not carry the valid quote from the prior ` +
                `402 (${validation.message}); sign the replacement requirements`,
            ),
          );
          return;
        }
        quoted = {
          amount: BigInt(validation.quote.amount),
          quote: validation.quote,
        };
      } else {
        quoted = await quoteOrRespond(res, offer, skillId, serviceArgs);
        if (!quoted) return;
      }
      if (value !== quoted.amount) {
        const timeout = boundedTimeoutSeconds(config, quoted.quote);
        if (timeout === null) {
          res.status(410).json({
            x402Version: core.version,
            error: "the accepted provider quote is too close to expiry",
          });
          return;
        }
        res.status(402).json(
          buildPaymentRequired(
            offer,
            quoted.amount,
            config,
            resourceUrl,
            timeout,
            purchaseLegal,
            quoted.quote,
            `authorization value ${auth.value} does not match the quoted ` +
              `amount ${quoted.amount.toString()}`,
          ),
        );
        return;
      }
    }

    const effectiveAmount = challenge ? challenge.amount : quoted!.amount;
    const quoteExpiresAtMs = challenge
      ? (challenge.quoteExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY)
      : Date.parse(quoted!.quote.expiresAt);
    const quoteRunway = Math.floor((quoteExpiresAtMs - Date.now()) / 1000);
    const needsExternalSettle = !challenge?.externalSettleTx;
    if (needsExternalSettle && quoteRunway < 15) {
      res.status(410).json({
        x402Version: core.version,
        error:
          "the provider quote has expired or has less than 15 seconds " +
          "remaining; request a fresh 402 and sign a new authorization",
      });
      return;
    }
    const timeoutSeconds = Math.max(
      1,
      Math.min(config.challengeTtlSeconds, quoteRunway),
    );
    const forwardedPayload = buildForwardedPayload(core, offer, resourceUrl);
    const facilitatorBody = {
      x402Version: core.version,
      paymentPayload: forwardedPayload,
      paymentRequirements: buildFacilitatorRequirements(
        core.version,
        offer,
        effectiveAmount,
        config,
        resourceUrl,
        timeoutSeconds,
      ),
    };

    // Fresh payment (or a retry that crashed before the external settle):
    // verify with the external facilitator BEFORE creating any state, so
    // a rejected payload leaves nothing behind; persist the challenge
    // BEFORE settle, so a crash between settle and attribution is
    // recoverable by replaying the same request.
    if (needsExternalSettle) {
      let verify;
      try {
        verify = await facilitator.verify(facilitatorBody);
      } catch (err) {
        res.status(502).json({
          x402Version: core.version,
          error: publicErrorMessage(
            "bazaar.externalVerify",
            err,
            "external payment verification failed",
          ),
        });
        return;
      }
      if (!verify.isValid) {
        if (!purchaseLegal) {
          res.status(409).json({
            x402Version: core.version,
            error: "payment_recovery_verification_failed",
            message:
              "The external facilitator rejected the persisted payment " +
              `authorization (${verify.invalidReason ?? "invalid"}). The ` +
              "existing challenge remains available for reconciliation; no " +
              "new payment requirements were issued.",
          });
          return;
        }
        res.status(402).json(
          buildPaymentRequired(
            offer,
            effectiveAmount,
            config,
            resourceUrl,
            timeoutSeconds,
            purchaseLegal,
            undefined,
            `external facilitator rejected the payment: ${verify.invalidReason ?? "invalid"}`,
          ),
        );
        return;
      }

      if (!challenge) {
        // Fresh payment: bind the challenge to the QUOTE's commitment.
        // The row dies with the quote — settling an authorization after
        // quote expiry captures funds the provider then refuses to
        // fulfill (quote_expired at consume time).
        const quote = quoted!.quote;
        const expiresAt = new Date(
          Math.min(
            Date.now() + config.challengeTtlSeconds * 1000,
            Date.parse(quote.expiresAt),
          ),
        );
        try {
          await queries.insertChallenge({
            serviceRef: quote.serviceRef,
            providerTokenId,
            buyerTokenId: buyerAgentId,
            amount: quoted!.amount,
            skillId,
            serviceSlug: offer.serviceSlug,
            serviceVersion: offer.serviceVersion,
            serviceId: offer.serviceId,
            providerA2AUrl: offer.providerA2AUrl,
            walletAddress: from,
            expiresAt,
            rail: "external",
            authNonce,
            quoteId: quote.quoteId,
            quoteSignature: quote.providerSignature,
            quoteExpiresAt: new Date(Date.parse(quote.expiresAt)),
            quoteRequestHash: quote.requestHash,
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
          error: publicErrorMessage(
            "bazaar.externalSettle",
            err,
            "external payment settlement failed",
          ),
        });
        return;
      }
      if (!settle.success) {
        if (!purchaseLegal) {
          res.status(502).json({
            x402Version: core.version,
            error: "payment_recovery_settlement_failed",
            message:
              "The external facilitator could not settle the persisted " +
              `payment (${settle.errorReason ?? "unknown"}). The existing ` +
              "challenge remains available for reconciliation; no new " +
              "payment requirements were issued.",
          });
          return;
        }
        res.status(402).json(
          buildPaymentRequired(
            offer,
            effectiveAmount,
            config,
            resourceUrl,
            timeoutSeconds,
            purchaseLegal,
            undefined,
            `external facilitator settle failed: ${settle.errorReason ?? "unknown"}`,
          ),
        );
        return;
      }
      const settleTx = (settle.transaction ?? "") as Hex;
      if (settleTx) {
        const recorded = await queries.recordChallengeExternallySettled(
          challenge.serviceRef,
          settleTx,
        );
        if (!recorded) {
          challenge = await queries.getChallengeByRef(challenge.serviceRef);
          if (!challenge?.externalSettleTx) {
            res.status(409).json({
              x402Version: core.version,
              error:
                "payment settled externally but the challenge state changed; " +
                "retry this exact request to resume attribution",
            });
            return;
          }
        } else {
          challenge = { ...challenge, status: "pending", externalSettleTx: settleTx };
        }
      }
    }

    if (!challenge) {
      // Unreachable: every path above either populated the row or
      // responded. Guard for the type system and future edits.
      res.status(500).json({
        x402Version: core.version,
        error: "challenge row missing before attribution",
      });
      return;
    }

    // Funds are on the router. Attribute: run the split + payment record
    // under the QUOTE's serviceRef, which is what the provider validates
    // at task-submit time.
    let attribution;
    try {
      attribution = await reader.attributeDirectTransfer({
        providerAgentId: challenge.providerTokenId,
        serviceId: challenge.serviceId,
        amount: challenge.amount,
        serviceRef: challenge.serviceRef,
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
        message: `${publicErrorMessage(
          "bazaar.attributeDirectTransfer",
          err,
          "payment settled on-chain but the commission split has not run",
        )}. Retry this exact request — the gateway resumes at attribution without re-charging.`,
        settlementTransaction: challenge.externalSettleTx,
        serviceRef: challenge.serviceRef,
      });
      return;
    }

    const event = attribution.event;
    const recorded = await queries.recordChallengePaid(
      challenge.serviceRef,
      event.paymentId,
      attribution.transactionHash,
      event.buyerAgentId,
    );
    if (!recorded) {
      res.status(500).json({
        x402Version: core.version,
        error: "settlement_persistence_conflict",
        message:
          "on-chain settlement conflicts with the stored payment challenge",
        serviceRef: challenge.serviceRef,
      });
      return;
    }
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
      transaction: challenge.externalSettleTx ?? attribution.transactionHash,
      network: config.network,
      payer: from,
    });
    res.status(200).json(
      receiptBody(core.version, config, {
        skillId: challenge.skillId ?? skillId,
        providerA2AUrl: challenge.providerA2AUrl,
      }, {
        paymentId: event.paymentId.toString(),
        serviceRef: challenge.serviceRef,
        providerTokenId: challenge.providerTokenId.toString(),
        buyerTokenId: event.buyerAgentId.toString(),
        amount: event.totalAmount.toString(),
        settlementTransaction: challenge.externalSettleTx,
        attributionTransaction: attribution.transactionHash,
        quoteId: challenge.quoteId,
        quoteSignature: challenge.quoteSignature,
        serviceArgs,
      }),
    );
  };

  // GET serves crawlers + human inspection; POST is the declared Bazaar
  // method (bodyType json, body.serviceArgs feeds the quote).
  router.get("/x402/services/:tokenId/:skillId", handler);
  router.post("/x402/services/:tokenId/:skillId", handler);

  return router;
}
