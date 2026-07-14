import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from "viem";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  cardsOf,
  extractAgentCardUrl,
  extractMarketplaceExtension,
  findCardForSkill,
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
import { buildPurchaseLegalContext } from "../legal/purchase.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";

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
  /**
   * Signed provider quote commitment (provider audit 1.1) from
   * POST /quote/:slug. When present, the challenge settles under the
   * QUOTE's serviceRef — `keccak256(canonicalJson(signedQuotePayload))` —
   * instead of a gateway-generated one, `amount` must equal the quoted
   * amount, and the challenge (plus the EIP-3009 validBefore) is bounded
   * by the quote's expiry. quoteId + providerSignature are persisted and
   * later forwarded as A2A metadata at task-submit time; the provider
   * rejects paid tasks without them.
   */
  providerQuote: {
    quoteId: string;
    serviceRef: Hex;
    requestHash: Hex;
    providerSignature: Hex;
    amount: string;
    expiresAt: Date;
    skillId: string;
    serviceSlug: string;
    serviceVersion: string;
  };
}

export type IssueResult =
  | { ok: true; requirements: PaymentRequirements; challenge: StoredChallenge }
  | { ok: false; code: string; message: string; status: number };

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
  const raw = meta?.["serviceVersion"] ?? meta?.["version"];
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
 * while a serviceSlug is the on-chain service identifier (e.g.
 * `domain-management`). One service can be implemented by many skills.
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
 *   keccak256(abi.encode(uint256 providerAgentId, string serviceSlug, string version))
 * Standard ABI encoding (NOT packed) — the contract switched to
 * `abi.encode` in the audit refactor, so the gateway must match byte-for
 * -byte. Off-chain identity is critical — the X402Adapter rejects any
 * settle whose EIP-3009 nonce isn't bound to the same `(serviceRef,
 * providerAgentId, serviceId)` 3-tuple, so a mismatch here surfaces as
 * "auth not bound to call" at settlement time.
 */
export function computeServiceId(
  providerAgentId: bigint,
  serviceSlug: string,
  version: string,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, string, string"), [
      providerAgentId,
      serviceSlug,
      version,
    ]),
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
  // Multi-service providers: the FIRST card that yields a valid slug is
  // the "primary" service (registration-file order — providers list
  // their flagship first). Callers that need a specific service should
  // resolve per skill via findCardForSkill instead.
  for (const card of cardsOf(provider)) {
    const ext = extractMarketplaceExtension(card.agentCard);
    if (!ext) continue;
    const skills = card.agentCard["skills"];
    if (!Array.isArray(skills) || skills.length === 0) continue;
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const id = (skill as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) continue;
      const serviceSlug = resolveServiceSlug(ext, card.agentCard, id);
      if (serviceSlug.length === 0 || serviceSlug.length > 64) continue;
      const serviceVersion = resolveServiceVersion(ext, card.agentCard, id);
      const serviceId = computeServiceId(
        provider.agentId,
        serviceSlug,
        serviceVersion,
      );
      return { serviceSlug, serviceVersion, serviceId };
    }
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

// ── Fixed-price skill offer (external rail / Bazaar) ─────────────────────

export interface SkillOffer {
  providerTokenId: bigint;
  skillId: string;
  /**
   * Static price in atomic USDC from the Agent Card. Null iff the caller
   * passed `requireFixedAmount: false` and the skill is live-priced — the
   * caller must then obtain the authoritative amount from the provider's
   * /quote endpoint (quote == charge).
   */
  amount: bigint | null;
  serviceSlug: string;
  serviceVersion: string;
  serviceId: Hex;
  providerA2AUrl: string;
  /** Human description for the 402 body / Bazaar catalog. ≤ 500 chars —
   *  the CDP facilitator rejects verify/settle with longer descriptions. */
  description: string;
}

function purchaseDescription(
  providerTokenId: bigint,
  agentCard: Record<string, unknown>,
  ext: DaskiMarketplaceExtension,
  skillId: string,
): string {
  const cardName =
    typeof agentCard.name === "string"
      ? agentCard.name
      : `provider ${providerTokenId}`;
  const serviceDescription =
    typeof ext.serviceDescription === "string" &&
    ext.serviceDescription.trim().length > 0
      ? ext.serviceDescription
      : typeof agentCard.description === "string" &&
          agentCard.description.trim().length > 0
        ? agentCard.description
        : "Service details are available from the Provider.";
  let skillDescription = skillId;
  const skills = agentCard.skills;
  if (Array.isArray(skills)) {
    const selected = skills.find(
      (skill) =>
        skill !== null &&
        typeof skill === "object" &&
        (skill as Record<string, unknown>).id === skillId,
    ) as Record<string, unknown> | undefined;
    if (
      typeof selected?.description === "string" &&
      selected.description.trim().length > 0
    ) {
      skillDescription = selected.description;
    }
  }
  return sanitizeForLlmReflection(
    `${cardName} — ${serviceDescription} Selected skill (${skillId}): ${skillDescription}`,
    { stringMax: 500 },
  );
}

export type SkillOfferResult =
  | { ok: true; offer: SkillOffer }
  | { ok: false; code: string; message: string; status: number };

function providerLegalAdmissionFailure(provider: CachedProvider): {
  ok: false;
  code: string;
  message: string;
  status: number;
} {
  const explicitlyInvalidLegalMetadata =
    provider.fetchError === null ||
    provider.fetchError.startsWith("invalid provider legal metadata:");
  return explicitlyInvalidLegalMetadata
    ? {
        ok: false,
        code: "provider_legal_metadata_invalid",
        message: "provider legal metadata is missing or invalid",
        status: 422,
      }
    : {
        ok: false,
        code: "provider_not_found",
        message: "provider is not currently admitted",
        status: 404,
      };
}

/**
 * Resolves the static, fixed-price offer for a (provider, skill) pair —
 * the shape the Bazaar-facing x402 route advertises in its 402 response
 * and validates paid retries against.
 *
 * Stricter than issuePaymentRequirements on two axes, both deliberate:
 *   - the skill must exist on one of the provider's cards (unknown skills
 *     404 so crawlers can't index garbage paths), and
 *   - the price must be a fixed non-zero baseAmount (skill-level, else
 *     service-level). Live-priced / priceList-only skills need a /quote
 *     hop, which the exact-scheme single-amount 402 cannot express.
 */
export function resolveSkillOffer(
  providerTokenId: bigint,
  skillId: string,
  cache: DiscoveryCache,
  opts: {
    /**
     * Default true: live-priced skills (no static baseAmount) fail with
     * `not_fixed_price`. The Bazaar route passes false since it now
     * quotes the provider for the authoritative amount anyway — the
     * offer's amount is then null and the quote is the price.
     */
    requireFixedAmount?: boolean;
  } = {},
): SkillOfferResult {
  const provider = cache.get(providerTokenId);
  if (!provider) {
    return {
      ok: false,
      code: "provider_not_found",
      message: "provider is not whitelisted",
      status: 404,
    };
  }
  if (!provider.providerLegal) {
    return providerLegalAdmissionFailure(provider);
  }
  if (skillId.length === 0 || skillId.length > 64) {
    return {
      ok: false,
      code: "skill_not_found",
      message: "skillId must be 1–64 bytes",
      status: 404,
    };
  }

  const agentCard = findCardForSkill(provider, skillId);
  if (!agentCard) {
    return {
      ok: false,
      code: "skill_not_found",
      message: `provider ${providerTokenId} does not list skill '${skillId}'`,
      status: 404,
    };
  }

  const ext = extractMarketplaceExtension(agentCard);
  const providerA2AUrl = extractAgentCardUrl(agentCard);
  if (!ext?.pricing || !providerA2AUrl) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card has no pricing extension or url",
      status: 422,
    };
  }

  const skillMeta = findSkillMetaForPricing(ext, agentCard, skillId);
  if (skillMeta && skillMeta["paymentRequired"] === false) {
    return {
      ok: false,
      code: "skill_is_free",
      message: `skill '${skillId}' is free (ownership-gated); nothing to purchase`,
      status: 404,
    };
  }

  // Fixed price only: skill-level baseAmount wins, else service-level.
  // "0" doubles as the live-pricing floor marker, so treat it as absent.
  let amount: bigint | null = null;
  for (const raw of [skillMeta?.["baseAmount"], ext.pricing.baseAmount]) {
    if (raw === undefined || raw === null) continue;
    try {
      const parsed = BigInt(raw as string | number);
      if (parsed > 0n) {
        amount = parsed;
        break;
      }
    } catch {
      // malformed — try the next source
    }
  }
  if (amount === null && (opts.requireFixedAmount ?? true)) {
    return {
      ok: false,
      code: "not_fixed_price",
      message:
        `skill '${skillId}' has no fixed baseAmount (live registrar ` +
        `pricing) and the caller required a static price. Quote the ` +
        `provider's /quote endpoint for the authoritative amount.`,
      status: 404,
    };
  }

  const serviceSlug = resolveServiceSlug(ext, agentCard, skillId);
  if (serviceSlug.length === 0 || serviceSlug.length > 64) {
    return {
      ok: false,
      code: "bad_service_slug",
      message: `resolved serviceSlug '${serviceSlug}' must be 1–64 bytes`,
      status: 422,
    };
  }
  const serviceVersion = resolveServiceVersion(ext, agentCard, skillId);
  const serviceId = computeServiceId(providerTokenId, serviceSlug, serviceVersion);

  const description = purchaseDescription(
    providerTokenId,
    agentCard,
    ext,
    skillId,
  );

  return {
    ok: true,
    offer: {
      providerTokenId,
      skillId,
      amount,
      serviceSlug,
      serviceVersion,
      serviceId,
      providerA2AUrl,
      description,
    },
  };
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
  if (!provider.providerLegal) {
    return providerLegalAdmissionFailure(provider);
  }
  const purchaseLegal = buildPurchaseLegalContext(config, provider.providerLegal);

  // Multi-service providers: everything below (pricing extension, A2A
  // endpoint, serviceSlug/serviceId derivation) must come from the CARD
  // that offers the requested skill, not the provider's first card.
  // Falls back to the first card when the skill isn't found (the
  // downstream skill checks surface the real error) or when no skillId
  // was supplied (legacy /purchase without one).
  const agentCard =
    findCardForSkill(provider, params.skillId) ?? provider.agentCard;

  const ext = extractMarketplaceExtension(agentCard);
  const providerA2AUrl = extractAgentCardUrl(agentCard);
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
      agentCard,
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
      agentCard,
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
  const serviceSlug = resolveServiceSlug(ext, agentCard, skillId);
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
  const serviceVersion = resolveServiceVersion(ext, agentCard, skillId);
  const serviceId = computeServiceId(
    params.providerTokenId,
    serviceSlug,
    serviceVersion,
  );

  // Provider quote commitment (audit 1.1). When the caller carried a
  // signed quote, the challenge MUST settle under the quote's own
  // commitment hash — the provider rejects any paid task whose settled
  // serviceRef is not exactly keccak256(canonicalJson(signedQuotePayload)),
  // with funds already captured. Cross-check the quote against the
  // resolved skill/slug and the charged amount HERE, before any USDC
  // moves, so drift surfaces as a clean 4xx instead of a captured-funds
  // disposition at task-submit time.
  const quote = params.providerQuote;
  {
    if (quote.skillId !== skillId) {
      return {
        ok: false,
        code: "quote_binding_mismatch",
        message: `provider quote is for skill '${quote.skillId}', not '${skillId}'`,
        status: 409,
      };
    }
    if (quote.serviceSlug !== serviceSlug) {
      return {
        ok: false,
        code: "quote_binding_mismatch",
        message:
          `provider quote is for serviceSlug '${quote.serviceSlug}' but the ` +
          `agent card resolves '${skillId}' to '${serviceSlug}' — provider ` +
          `catalog and Agent Card have drifted`,
        status: 409,
      };
    }
    if (quote.serviceVersion !== serviceVersion) {
      return {
        ok: false,
        code: "quote_binding_mismatch",
        message:
          `provider quote is for serviceVersion '${quote.serviceVersion}' but ` +
          `the agent card resolves '${skillId}' to '${serviceVersion}'`,
        status: 409,
      };
    }
    let quotedAmount: bigint | null = null;
    try {
      quotedAmount = BigInt(quote.amount);
    } catch {
      // handled below
    }
    if (quotedAmount === null || quotedAmount !== amount) {
      return {
        ok: false,
        code: "quote_amount_mismatch",
        message:
          `charged amount ${amount.toString()} must equal the quoted amount ` +
          `${quote.amount} — the provider settles quote == charge`,
        status: 409,
      };
    }
    // A quote on the verge of expiry cannot realistically be signed,
    // settled on-chain, AND submitted before it dies — refuse early so
    // the orchestrator re-quotes instead of capturing doomed funds.
    if (quote.expiresAt.getTime() <= now.getTime() + 15_000) {
      return {
        ok: false,
        code: "quote_expired",
        message:
          "provider quote is expired (or expires in <15s). Re-quote and " +
          "retry — provider quotes are short-lived (~120s).",
        status: 409,
      };
    }
  }
  const serviceRef = quote.serviceRef;
  // Quote-backed challenges live exactly as long as the quote: settling
  // an authorization after quote expiry would capture funds the provider
  // then refuses to fulfill.
  const expiresAt = new Date(
    Math.min(
      now.getTime() + config.challengeTtlSeconds * 1000,
      quote ? quote.expiresAt.getTime() : Number.POSITIVE_INFINITY,
    ),
  );

  let existingChallenge = quote
    ? await queries.getChallengeByRef(serviceRef)
    : null;
  const existingMatches = (existing: StoredChallenge): boolean =>
    existing.status === "pending" &&
    existing.expiresAt.getTime() > now.getTime() + 15_000 &&
    existing.providerTokenId === params.providerTokenId &&
    existing.buyerTokenId === params.buyerTokenId &&
    existing.amount === amount &&
    existing.skillId === skillId &&
    existing.serviceSlug === serviceSlug &&
    existing.serviceVersion === serviceVersion &&
    existing.serviceId.toLowerCase() === serviceId.toLowerCase() &&
    existing.providerA2AUrl === providerA2AUrl &&
    existing.walletAddress.toLowerCase() === params.walletAddress.toLowerCase() &&
    existing.quoteId === quote?.quoteId &&
    existing.quoteSignature?.toLowerCase() ===
      quote?.providerSignature.toLowerCase() &&
    existing.quoteRequestHash?.toLowerCase() === quote?.requestHash.toLowerCase();

  if (existingChallenge && !existingMatches(existingChallenge)) {
    return {
      ok: false,
      code: "quote_already_used",
      message:
        "this provider quote is already bound to a different or completed " +
        "payment challenge; request a fresh quote",
      status: 409,
    };
  }

  if (!existingChallenge) {
    try {
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
        quoteId: quote?.quoteId ?? null,
        quoteSignature: quote?.providerSignature ?? null,
        quoteExpiresAt: quote?.expiresAt ?? null,
        quoteRequestHash: quote?.requestHash ?? null,
      });
    } catch (error) {
      if (
        quote &&
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23505"
      ) {
        existingChallenge = await queries.getChallengeByRef(serviceRef);
        if (!existingChallenge || !existingMatches(existingChallenge)) {
          return {
            ok: false,
            code: "quote_already_used",
            message:
              "this provider quote was claimed by another payment challenge; " +
              "request a fresh quote",
            status: 409,
          };
        }
      } else {
        throw error;
      }
    }
  }

  const effectiveExpiresAt = existingChallenge?.expiresAt ?? expiresAt;

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
  const validAfter = 0n;
  // The authorization dies with the challenge — which for quote-backed
  // challenges means with the QUOTE (min above). Without this, a buyer
  // could settle a payment whose quote already expired and the provider
  // would refuse the task after capturing funds.
  const validBefore = BigInt(Math.floor(effectiveExpiresAt.getTime() / 1000));

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
    description: purchaseDescription(
      params.providerTokenId,
      agentCard,
      ext,
      skillId,
    ),
    mimeType: "application/json",
    payTo: config.paymentRouterAddress,
    maxTimeoutSeconds: Math.max(
      1,
      Math.floor((effectiveExpiresAt.getTime() - now.getTime()) / 1000),
    ),
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
        ...(quote
          ? {
              quote: {
                quoteId: quote.quoteId,
                quoteSignature: quote.providerSignature,
                expiresAt: quote.expiresAt.toISOString(),
              },
            }
          : {}),
        ...purchaseLegal,
      },
    },
  };

  const challenge: StoredChallenge = existingChallenge ?? {
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
    expiresAt: effectiveExpiresAt,
    status: "pending",
    paymentId: null,
    transactionHash: null,
    verifiedAt: null,
    confirmationAttestationUid: null,
    rail: "daski",
    authNonce: null,
    externalSettleTx: null,
    quoteId: quote?.quoteId ?? null,
    quoteSignature: quote?.providerSignature ?? null,
    quoteExpiresAt: quote?.expiresAt ?? null,
    quoteRequestHash: quote?.requestHash ?? null,
  };

  return { ok: true, requirements, challenge };
}
