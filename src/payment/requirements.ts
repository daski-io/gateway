import crypto from "node:crypto";
import { encodeAbiParameters, encodePacked, keccak256 } from "viem";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  extractAgentCardUrl,
  extractMarketplaceExtension,
} from "../discovery/format.js";
import type { Queries } from "../db/queries.js";
import type {
  CachedProvider,
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
 * Default version used when the provider's Agent Card does not advertise
 * one. Matches the convention documented on the contract
 * (`registerService(.., version="1", ..)`). Free-form, but providers and
 * the gateway must agree — the version is part of the serviceId hash.
 */
const DEFAULT_SERVICE_VERSION = "1";

/**
 * Pulls the per-skill `version` field out of the provider's Agent Card.
 * Looks in the same two locations as findSkillMetaForPricing — falls back
 * to "1" when missing or non-string.
 */
function resolveServiceVersion(
  ext: DaskiMarketplaceExtension,
  agentCard: Record<string, unknown>,
  skillId: string,
): string {
  const meta = findSkillMetaForPricing(ext, agentCard, skillId);
  const raw = meta?.["version"];
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 32) {
    return raw;
  }
  return DEFAULT_SERVICE_VERSION;
}

/**
 * Resolves the **on-chain serviceSlug** for a given A2A skillId.
 *
 * Per the three-layer identity model (provider / service / skill), a
 * skillId is the off-chain A2A method name (e.g. `register-domain`),
 * while a serviceSlug is the on-chain product category (e.g.
 * `domain-registration`). One service can be implemented by many skills.
 *
 * Resolution order:
 *   1. The skill's daski metadata explicitly declares `serviceSlug` —
 *      provider follows the corrected convention.
 *   2. Fallback: use the skillId itself as the slug. Preserves
 *      backwards compat with providers whose Agent Card was authored
 *      under the pre-fix model (one service per skill — wrong
 *      cardinality, but functionally correct so payments still settle).
 *
 * The fallback path will leave provider reputation fragmented across
 * skills; the right answer is for providers to declare serviceSlug in
 * their Agent Card. Until they do, we don't synthesize a wrong slug.
 */
function resolveServiceSlug(
  ext: DaskiMarketplaceExtension,
  agentCard: Record<string, unknown>,
  skillId: string,
): string {
  const meta = findSkillMetaForPricing(ext, agentCard, skillId);
  const raw = meta?.["serviceSlug"];
  if (typeof raw === "string" && raw.length > 0 && raw.length <= 64) {
    return raw;
  }
  // Fallback: skillId becomes the slug. Legacy 1:1 cardinality.
  return skillId;
}

/**
 * Off-chain serviceId derivation. Mirrors
 * `ServiceRegistry._computeServiceId`:
 *   keccak256(abi.encodePacked(uint256 providerAgentId, string serviceSlug, string version))
 * Off-chain identity is critical — the X402Adapter rejects any settle
 * whose EIP-3009 nonce isn't bound to the same `(serviceRef,
 * providerAgentId, serviceId)` 3-tuple, so a mismatch here surfaces as
 * "auth not bound to call" at settlement time.
 */
export function computeServiceId(
  providerAgentId: bigint,
  serviceSlug: string,
  version: string,
): Hex {
  return keccak256(
    encodePacked(
      ["uint256", "string", "string"],
      [providerAgentId, serviceSlug, version],
    ),
  ) as Hex;
}

/**
 * Resolves the **primary service triple** for a cached provider — i.e. the
 * (serviceSlug, version, serviceId) that the provider's first listed skill
 * rolls up to on-chain. Picks the first skill with valid metadata.
 *
 * With current 1:1 cardinality (one provider lists one service), this is
 * also the only service. Once providers list multiple services we'd return
 * an array; for now this is what the public detail route uses to scope
 * service-level reputation reads without changing the URL shape.
 *
 * Returns null when the provider has no skills, no marketplace extension,
 * or no skill whose slug passes the contract's 1–64-byte bound.
 */
export function derivePrimaryServiceId(
  provider: CachedProvider,
): { serviceSlug: string; serviceVersion: string; serviceId: Hex } | null {
  const ext = extractMarketplaceExtension(provider.agentCard);
  if (!ext) return null;
  const skills = provider.agentCard["skills"];
  if (!Array.isArray(skills) || skills.length === 0) return null;
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const id = (skill as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const serviceSlug = resolveServiceSlug(ext, provider.agentCard, id);
    if (serviceSlug.length === 0 || serviceSlug.length > 64) continue;
    const serviceVersion = resolveServiceVersion(ext, provider.agentCard, id);
    const serviceId = computeServiceId(
      provider.agentId,
      serviceSlug,
      serviceVersion,
    );
    return { serviceSlug, serviceVersion, serviceId };
  }
  return null;
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
          `fetch and sign the EIP-712 capability via the provider's ` +
          `'prepare-dns-capability' (or equivalent) free A2A skill.`,
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

  // Service-identity refactor: every paid settle binds to a row in
  // ServiceRegistry. We resolve the on-chain serviceSlug from the
  // skill's daski metadata (the new three-layer model); providers that
  // haven't declared serviceSlug yet fall back to skillId-as-slug to
  // preserve backwards compat. Either way, the resulting serviceSlug
  // must be 1–64 bytes (contract enforces this on registerService).
  const skillId = params.skillId ?? null;
  if (!skillId || skillId.length === 0 || skillId.length > 64) {
    return {
      ok: false,
      code: "skill_id_required",
      message:
        "skillId is required and must be 1–64 bytes — every payment is " +
        "bound to a specific service in ServiceRegistry. Pass the " +
        "AgentSkill.id from the provider's Agent Card.",
      status: 400,
    };
  }
  const serviceSlug = resolveServiceSlug(ext, provider.agentCard, skillId);
  if (serviceSlug.length === 0 || serviceSlug.length > 64) {
    return {
      ok: false,
      code: "bad_service_slug",
      message:
        `resolved serviceSlug '${serviceSlug}' must be 1–64 bytes; check ` +
        `the provider's Agent Card skill metadata for the daski extension.`,
      status: 400,
    };
  }
  const serviceVersion = resolveServiceVersion(ext, provider.agentCard, skillId);
  const serviceId = computeServiceId(
    params.providerTokenId,
    serviceSlug,
    serviceVersion,
  );
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
    serviceSlug,
    serviceVersion,
    serviceId,
    providerA2AUrl,
    walletAddress: params.walletAddress,
    expiresAt,
  });

  // Pre-bake the EIP-712 typed-data so the agent's wallet can sign verbatim.
  // validBefore is gateway-chosen here; the wallet signs it exactly, and
  // verifyAndSettle later recovers the signature against the same value.
  // validAfter is always 0 — no delayed-start semantics for settlement.
  //
  // The EIP-3009 nonce MUST be
  // `keccak256(abi.encode(serviceRef, providerAgentId, serviceId))`.
  // Post-refactor X402Adapter rejects calls whose auth.nonce doesn't match
  // this 3-tuple, so a frontrunner cannot redirect the auth to a
  // different service or provider. See
  // daski/src/adapters/X402Adapter.sol contract NatSpec ("AUTH BINDING").
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [serviceRef, params.providerTokenId, serviceId],
    ),
  ) as Hex;
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
        serviceSlug,
        serviceVersion,
        serviceId,
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
    serviceSlug,
    serviceVersion,
    serviceId,
    amount,
    providerA2AUrl,
    walletAddress: params.walletAddress.toLowerCase() as Hex,
    createdAt: now,
    expiresAt,
    status: "pending",
    paymentId: null,
    transactionHash: null,
    verifiedAt: null,
    confirmationAttestationUid: null,
  };

  return { ok: true, requirements, challenge };
}
