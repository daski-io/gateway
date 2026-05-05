import crypto from "node:crypto";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  extractAgentCardUrl,
  extractMarketplaceExtension,
} from "../discovery/format.js";
import type { Queries } from "../db/queries.js";
import type {
  DaskiMarketplaceExtension,
  DaskiRail,
  Eip712TypedData,
  Hex,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";

// EIP-3009 TransferWithAuthorization — the same struct verifyAndSettle
// recovers against. Embedded inline in the 402 response so any wallet
// that supports generic EIP-712 signing can sign without knowing Daski's
// schemas.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Builds the informational rail list advertised to buyers. X402 is always
 * present (required adapter); permit/approval adapters appear only when
 * their addresses are configured in env. See `DaskiRail` for semantics.
 */
function buildRails(config: Config): DaskiRail[] {
  const rails: DaskiRail[] = [
    { name: "x402", kind: "eip3009", adapter: config.x402AdapterAddress },
  ];
  if (config.permitAdapterAddress) {
    rails.push({
      name: "permit",
      kind: "eip2612",
      adapter: config.permitAdapterAddress,
    });
  }
  if (config.approvalAdapterAddress) {
    rails.push({
      name: "approval",
      kind: "erc20-approve",
      adapter: config.approvalAdapterAddress,
    });
  }
  return rails;
}

export interface IssueParams {
  providerTokenId: bigint;
  buyerTokenId: bigint;
  skillId?: string;
  amount?: string;
  resource: string;
  /**
   * The wallet address that will sign the EIP-3009 authorization. Required
   * because the gateway bakes it into the typed-data `from` field so the
   * wallet can sign verbatim. The signature must recover to this address
   * at /settle time.
   */
  walletAddress: Hex;
  /**
   * If true, `amount` is treated as authoritative — typically because the
   * orchestrator just got it from a live provider /quote. resolveAmount's
   * static floor check (skill.baseAmount / priceList minimum) is skipped:
   * the registrar's live price is the truth, even if the agent card's
   * advertised baseAmount is stale and higher.
   */
  trustQuotedAmount?: boolean;
}

export type IssueResult =
  | { ok: true; requirements: PaymentRequirements; challenge: StoredChallenge }
  | { ok: false; code: string; message: string; status: number };

function generateServiceRef(): Hex {
  return `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
}

/**
 * Pulls the daski marketplace skill metadata for a given skillId from an
 * Agent Card. Supports both publishing shapes observed in the wild:
 *   A) `skills[i].metadata[DASKI_A2A_EXTENSION_URI]`
 *   B) `extensions[DASKI_A2A_EXTENSION_URI].skills[skillId]` (what
 *      daski-provider serves today)
 * Returns null when the skill is not listed or its metadata is missing.
 */
function findSkillMetaForPricing(
  ext: DaskiMarketplaceExtension,
  agentCard: Record<string, unknown>,
  skillId: string,
): Record<string, unknown> | null {
  const skills = agentCard["skills"];
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      if ((skill as Record<string, unknown>)["id"] !== skillId) continue;
      const meta = (skill as Record<string, unknown>)["metadata"];
      if (meta && typeof meta === "object") {
        const daskiMeta = (meta as Record<string, unknown>)[
          DASKI_A2A_EXTENSION_URI
        ];
        if (daskiMeta && typeof daskiMeta === "object") {
          return daskiMeta as Record<string, unknown>;
        }
      }
      break;
    }
  }
  const skillMap = (ext as unknown as { skills?: unknown })?.skills;
  if (skillMap && typeof skillMap === "object" && !Array.isArray(skillMap)) {
    const meta = (skillMap as Record<string, unknown>)[skillId];
    if (meta && typeof meta === "object") {
      return meta as Record<string, unknown>;
    }
  }
  return null;
}

function parsePriceList(raw: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!raw || typeof raw !== "object") return out;
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row && typeof row === "object") {
        const item = (row as Record<string, unknown>)["item"];
        const amount = (row as Record<string, unknown>)["amount"];
        if (typeof item === "string" && (typeof amount === "string" || typeof amount === "number")) {
          try {
            out.set(item, BigInt(amount));
          } catch {
            // skip malformed entries
          }
        }
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number") {
      try {
        out.set(k, BigInt(v));
      } catch {
        // skip
      }
    }
  }
  return out;
}

function resolveAmount(
  ext: DaskiMarketplaceExtension,
  agentCard: Record<string, unknown>,
  skillId?: string,
  requestedAmount?: string,
):
  | { ok: true; amount: bigint }
  | { ok: false; code: string; message: string; status: number } {
  const skillMeta = skillId
    ? findSkillMetaForPricing(ext, agentCard, skillId)
    : null;

  let skillBaseAmount: bigint | null = null;
  if (skillMeta && skillMeta["baseAmount"] !== undefined) {
    try {
      skillBaseAmount = BigInt(skillMeta["baseAmount"] as string | number);
    } catch {
      // fall through — treat as absent
    }
  }

  const priceList = skillMeta ? parsePriceList(skillMeta["priceList"]) : new Map();
  // When a priceList is present, the floor is its minimum entry, not the
  // skill / service baseAmount — TLDs like .xyz are legitimately cheaper
  // than the headline baseAmount for register-domain.
  const priceListMin = priceList.size
    ? [...priceList.values()].reduce((a, b) => (b < a ? b : a))
    : null;

  if (requestedAmount) {
    let amount: bigint;
    try {
      amount = BigInt(requestedAmount);
    } catch {
      return {
        ok: false,
        code: "invalid_payload",
        message: "amount must be a numeric string",
        status: 400,
      };
    }
    // Accept any exact priceList entry first — sub-floor TLD prices are
    // authorized by the skill's published per-item pricing.
    for (const v of priceList.values()) {
      if (v === amount) return { ok: true, amount };
    }
    // Otherwise fall back to floor checks: prefer skill.baseAmount when
    // known, then priceList min, then service-level baseAmount. For
    // variable-priced skills none of these may be set — in that case the
    // caller's quote is authoritative (the buyer just hit the provider's
    // /quote, and the provider will refuse fulfillment if under-paid).
    let floor: bigint | null = skillBaseAmount ?? priceListMin;
    if (floor === null && ext.pricing.baseAmount !== undefined) {
      try {
        floor = BigInt(ext.pricing.baseAmount);
      } catch {
        // service-level baseAmount is malformed — treat as absent rather
        // than crashing. Falling through to floor=null trusts the quote.
      }
    }
    if (floor !== null && amount < floor) {
      return {
        ok: false,
        code: "amount_below_minimum",
        message:
          `requested amount ${requestedAmount} is below minimum ${floor.toString()}` +
          (priceList.size
            ? ` (priceList entries: ${[...priceList.entries()]
                .map(([k, v]) => `${k}=${v}`)
                .join(", ")})`
            : ""),
        status: 400,
      };
    }
    return { ok: true, amount };
  }

  if (skillBaseAmount !== null) {
    return { ok: true, amount: skillBaseAmount };
  }

  try {
    return { ok: true, amount: BigInt(ext.pricing.baseAmount) };
  } catch {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "pricing.baseAmount is not a valid integer string",
      status: 422,
    };
  }
}

export async function issuePaymentRequirements(
  params: IssueParams,
  config: Config,
  cache: DiscoveryCache,
  queries: Queries,
  now: Date = new Date(),
): Promise<IssueResult> {
  const provider = cache.get(params.providerTokenId);
  if (!provider) {
    return {
      ok: false,
      code: "provider_not_found",
      message: "provider is not whitelisted",
      status: 404,
    };
  }

  const ext = extractMarketplaceExtension(provider.agentCard);
  const providerA2AUrl = extractAgentCardUrl(provider.agentCard);
  // Live-priced services intentionally have no pricing.baseAmount; the
  // orchestrator (daski_buy_service) hits /quote first and passes
  // trustQuotedAmount=true so we skip the resolveAmount path entirely.
  // We only need a fallback baseAmount when the caller didn't pre-quote.
  const needsFallback = !params.trustQuotedAmount && !params.amount;
  if (needsFallback && !ext?.pricing?.baseAmount) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message:
        "this provider uses live registrar pricing (no fixed baseAmount). " +
        "Call /quote (or daski_buy_service) for the actual price, then " +
        "call this endpoint with `amount` set to the quoted value.",
      status: 422,
    };
  }
  if (!ext?.pricing) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card has no pricing extension",
      status: 422,
    };
  }
  if (!providerA2AUrl) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card is missing url",
      status: 422,
    };
  }

  // Guard: if the skillId points at a free (ownership-gated) skill, we
  // must NOT issue PaymentRequirements — a fresh payment would be real
  // on-chain USDC burned for nothing, because the provider's A2A handler
  // dispatches free skills via handleFreeSkill and refuses them in the
  // paid-skill path. Agents hit this when they mistake a free skill
  // (set-dns-record, list-dns-records) for a paid one.
  if (params.skillId) {
    const skillMeta = findSkillMetaForPricing(
      ext,
      provider.agentCard,
      params.skillId,
    );
    if (skillMeta && skillMeta["paymentRequired"] === false) {
      return {
        ok: false,
        code: "skill_is_free",
        message:
          `Skill '${params.skillId}' is free (ownership-gated). Do not ` +
          `issue a new payment. Reuse the paymentId from the original ` +
          `asset purchase (e.g. register-domain) and call daski_submit_task ` +
          `directly — if the skill's requiresCapability flag is set, first ` +
          `sign an EIP-712 capability with the matching daski_sign_* skill action.`,
        status: 400,
      };
    }
  }

  // Trusted-quote path: orchestrator just hit the provider's /quote
  // endpoint and got the live registrar price. Skip the static floor
  // check; the live quote IS the floor.
  let amount: bigint;
  if (params.trustQuotedAmount && params.amount) {
    try {
      amount = BigInt(params.amount);
    } catch {
      return {
        ok: false,
        code: "invalid_payload",
        message: "amount must be a numeric string",
        status: 400,
      };
    }
    if (amount <= 0n) {
      return {
        ok: false,
        code: "invalid_payload",
        message: "amount must be > 0",
        status: 400,
      };
    }
  } else {
    const amountResult = resolveAmount(
      ext,
      provider.agentCard,
      params.skillId,
      params.amount,
    );
    if (!amountResult.ok) return amountResult;
    amount = amountResult.amount;
  }

  const skillId = params.skillId ?? null;
  const serviceRef = generateServiceRef();
  const expiresAt = new Date(
    now.getTime() + config.challengeTtlSeconds * 1000,
  );

  await queries.insertChallenge({
    serviceRef,
    providerTokenId: params.providerTokenId,
    buyerTokenId: params.buyerTokenId,
    amount,
    skillId,
    providerA2AUrl,
    walletAddress: params.walletAddress,
    expiresAt,
  });

  // Pre-bake the EIP-712 typed-data so the agent's wallet can sign verbatim.
  // nonce + validBefore are gateway-chosen here; the wallet signs them
  // exactly, and verifyAndSettle later recovers the signature against the
  // same values. validAfter is always 0 — we don't need delayed-start
  // semantics for marketplace settlement.
  const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as Hex;
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  const validAfter = 0n;
  const validBefore = nowSec + BigInt(config.challengeTtlSeconds);

  const eip712TypedData: Eip712TypedData = {
    domain: {
      name: config.usdcName,
      version: config.usdcVersion,
      chainId: config.chainId,
      verifyingContract: config.usdcAddress,
    },
    types: {
      TransferWithAuthorization:
        TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => ({
          name: f.name,
          type: f.type,
        })),
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: params.walletAddress,
      to: config.paymentRouterAddress,
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: config.network,
    // §1.2 — CAIP-2 dual-emit (`eip155:<chainId>`). v1 facilitators read
    // `network`; x402 v2 facilitators (OpenZeppelin Relayer x402 plugin,
    // x402-rs v2) read `chainId`. Both refer to the same chain.
    chainId: `eip155:${config.chainId}`,
    maxAmountRequired: amount.toString(),
    resource: params.resource,
    description: `Daski service purchase (providerTokenId ${params.providerTokenId})${skillId ? ` — skill ${skillId}` : ""}`,
    mimeType: "application/json",
    payTo: config.paymentRouterAddress,
    maxTimeoutSeconds: config.challengeTtlSeconds,
    asset: config.usdcAddress,
    outputSchema: null,
    extra: {
      name: config.usdcName,
      version: config.usdcVersion,
      daski: {
        providerTokenId: params.providerTokenId.toString(),
        buyerTokenId: params.buyerTokenId.toString(),
        skillId,
        serviceRef,
        token: config.usdcAddress,
        rails: buildRails(config),
        acceptedTokens: [config.usdcAddress],
        eip712TypedData,
        // Atomic register-and-settle when buyer has no agentId yet — see
        // X402Adapter.settleWithRegistration. settle-only otherwise.
        settlementMode:
          params.buyerTokenId === 0n ? "atomic-register" : "settle-only",
      },
    },
  };

  const challenge: StoredChallenge = {
    serviceRef,
    providerTokenId: params.providerTokenId,
    buyerTokenId: params.buyerTokenId,
    skillId,
    amount,
    providerA2AUrl,
    walletAddress: params.walletAddress.toLowerCase() as Hex,
    createdAt: now,
    expiresAt,
    status: "pending",
    paymentId: null,
    transactionHash: null,
    verifiedAt: null,
  };

  return { ok: true, requirements, challenge };
}
