import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type {
  BuyerConfirmationLabel,
  ProviderReputation,
  ReputationRecord,
  ServiceReputation,
  TransactionOutcome,
} from "../chain/reader.js";
import {
  extractAgentCardName,
  extractAgentCardUrl,
  extractMarketplaceExtension,
} from "../discovery/format.js";
import { derivePrimaryServiceId } from "../payment/requirements.js";
import type { CachedProvider, Hex, StoredChallenge } from "../types.js";

/**
 * Curated, UI-friendly view of a service offered by one provider. This is
 * the wire shape served by /public/v1/services — distinct from the discovery
 * `/discover` shape (which dumps the raw Agent Card and is consumed by
 * agents) because the marketing site needs a flat, predictable schema with
 * human-readable prices, not raw atomic units.
 */
export interface PublicService {
  agentId: string;
  name: string;
  providerAddress: Hex;
  agentURI: string;
  category: string | null;
  serviceDescription: string | null;
  serviceLifecycle: string | null;
  turnaroundEstimate: string | null;
  providerA2AUrl: string | null;
  /**
   * Provider-level identity from the ERC-8004 registration file's top-level
   * `name`/`description`. Distinct from `name` (the service offering, from
   * the agent card) — one provider can host multiple services under the
   * same brand. Null for providers serving a flat agent card.
   */
  providerName: string | null;
  providerDescription: string | null;
  /**
   * Primary on-chain service identity for this provider. With current 1:1
   * cardinality (one provider lists one service), this is the only service;
   * when providers list multiple, this remains the first one and the others
   * would be exposed via a future per-service route. Null if the provider's
   * agent card has no resolvable skill / marketplace extension.
   */
  serviceId: Hex | null;
  serviceSlug: string | null;
  serviceVersion: string | null;
  pricing: PublicServicePricing;
  skills: PublicSkill[];
}

export interface PublicServicePricing {
  currency: string | null;
  /** USDC, two-decimal string. Null when the service uses live pricing. */
  basePrice: string | null;
  /** Live-pricing model identifier (e.g. "live") when set, else null. */
  pricingModel: string | null;
  variable: boolean;
  billingModel: string | null;
}

export interface PublicSkillPricingModel {
  /** "live" for registrar/quote-driven skills; reserved for future kinds. */
  kind: string;
  /** Where the live quote comes from (e.g. "registrar"). */
  source: string | null;
  /** Human-readable hint shown to integrators / on the website. */
  hint: string | null;
}

export interface PublicSkill {
  id: string;
  name: string;
  description: string | null;
  /** USDC, two-decimal string. Null when the skill uses live pricing. */
  basePrice: string | null;
  /**
   * Legacy field — kept for back-compat. New consumers should read
   * `pricingModelDetail` for the structured form.
   */
  pricingModel: string | null;
  pricingModelDetail: PublicSkillPricingModel | null;
  variable: boolean;
  paymentRequired: boolean;
  /** Asset/capability shape — needed by integrators to know what to send. */
  requiredFields: string[] | null;
  requiresAssetOwnership: boolean;
  requiresCapability: boolean;
  assetType: string | null;
}

/**
 * Provider-level reputation derived from `ReputationStorage.getProviderStats`.
 *
 * The contract returns raw counters; the website wants ranked-friendly rates
 * plus the underlying volume. We derive both here so all consumers share the
 * same definition (and the website doesn't have to handle divide-by-zero
 * across multiple components).
 *
 * Rates are 0..1 floats, or null when the denominator is zero — null encodes
 * "no data" cleanly for the UI's empty state. `totalTransactions` is the
 * combined outcome count (completed + failed + canceled), which is what the
 * whitepaper §Trust Model labels "Volume" and what discovery ranking weights
 * with. It is NOT confirmed + notConfirmed: a buyer can confirm later or
 * never, so a transaction can exist without a confirmation pair.
 */
export interface PublicServiceReputation {
  totalTransactions: number;
  completionRate: number | null;
  buyerSatisfactionRate: number | null;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  confirmedCount: number;
  notConfirmedCount: number;
  /**
   * Total USDC settled through this gateway at this scope (provider-level
   * for `reputation`, service-level for `serviceReputation`), two-decimal
   * string. Sourced from `payment_challenges.amount` summed over paid
   * rows — the gateway DB, not on-chain, because ReputationStorage tracks
   * outcome counts but not dollar amounts. Always present; "0.00" when no
   * paid rows have landed yet.
   */
  totalSpentUsdc: string;
}

export function deriveProviderReputation(
  raw: ProviderReputation,
  totalSpentAtomic: bigint = 0n,
): PublicServiceReputation {
  const completed = Number(raw.completed);
  const failed = Number(raw.failed);
  const canceled = Number(raw.canceled);
  const confirmed = Number(raw.confirmed);
  const notConfirmed = Number(raw.notConfirmed);
  const totalTransactions = completed + failed + canceled;
  const totalConfirmations = confirmed + notConfirmed;
  return {
    totalTransactions,
    completionRate:
      totalTransactions > 0 ? completed / totalTransactions : null,
    buyerSatisfactionRate:
      totalConfirmations > 0 ? confirmed / totalConfirmations : null,
    completedCount: completed,
    failedCount: failed,
    canceledCount: canceled,
    confirmedCount: confirmed,
    notConfirmedCount: notConfirmed,
    totalSpentUsdc: atomicToUsdc(totalSpentAtomic),
  };
}

/**
 * Service-scoped reputation. Same outcome shape as the provider-level
 * counters (so the UI can reuse rate derivations) plus `totalRefundedUsdc`,
 * which the contract tracks per-service only, and the on-chain `serviceId`
 * so consumers can deep-link to ServiceRegistry / cross-reference logs.
 *
 * `averageFulfillmentSeconds` is computed off-chain over the most recent
 * paid purchases for this serviceId — the contract stores per-record
 * fulfillment time but no aggregate, and a full all-time scan would be
 * unbounded RPC cost on hot services. `fulfillmentSampleSize` is the
 * number of records that actually contributed to the mean (i.e. had a
 * provider-attested outcome), so consumers can distinguish "average over
 * 100 fulfilled tasks" from "average over 2 fulfilled tasks (low signal)".
 */
export interface PublicServiceLevelReputation extends PublicServiceReputation {
  /** USDC, two-decimal string. Atomic sum of refunds for this serviceId. */
  totalRefundedUsdc: string;
  /** 32-byte hex serviceId of the service these counters scope to. */
  serviceId: Hex;
  /** Mean fulfillment time in whole seconds; null when no fulfilled samples. */
  averageFulfillmentSeconds: number | null;
  /** Count of records that contributed to the mean. */
  fulfillmentSampleSize: number;
}

export function deriveServiceReputation(
  raw: ServiceReputation,
  serviceId: Hex,
  fulfillment: {
    averageFulfillmentSeconds: number | null;
    sampleSize: number;
  } = { averageFulfillmentSeconds: null, sampleSize: 0 },
  totalSpentAtomic: bigint = 0n,
): PublicServiceLevelReputation {
  // ServiceReputation is structurally a superset of ProviderReputation
  // (same five outcome counters plus totalRefunded), so the existing rate
  // derivation works unchanged. The fulfillment aggregate is mixed in
  // separately because it's computed off-chain from per-record reads —
  // callers without that data pass the default zero-sample object. The
  // spend total comes from the gateway DB (not the contract) and is
  // scoped to this serviceId.
  return {
    ...deriveProviderReputation(raw, totalSpentAtomic),
    totalRefundedUsdc: atomicToUsdc(raw.totalRefunded),
    serviceId,
    averageFulfillmentSeconds: fulfillment.averageFulfillmentSeconds,
    fulfillmentSampleSize: fulfillment.sampleSize,
  };
}

export interface PublicActivityRow {
  /** Always set — only paid rows are emitted. */
  txHash: Hex;
  buyerAgentId: string;
  providerAgentId: string;
  /** Resolved from the discovery cache; null if the provider has been
   *  deregistered or removed from the whitelist since this row landed. */
  providerName: string | null;
  /** USDC, two-decimal string. */
  amount: string;
  skillId: string | null;
  /** ISO-8601 timestamp of on-chain settlement (verified_at). */
  timestamp: string;
  /**
   * Provider-attested outcome from ReputationStorage. "Completed" / "Failed"
   * / "Canceled" once the provider has attested; null while pending. The
   * gateway never derives this off-chain — it reflects what the provider
   * signed via EAS.
   */
  outcome: TransactionOutcome | null;
  /**
   * Buyer's confirmation attestation. "Pending" = no confirmation yet,
   * which is the steady state for rows that never get confirmed.
   */
  confirmation: BuyerConfirmationLabel;
  /**
   * Seconds between PaymentRouter.paidAt and the provider's outcome
   * attestation. Computed ON-CHAIN as `block.timestamp - paidAt` so the
   * provider cannot self-report. Null until the outcome is attested.
   */
  fulfillmentSeconds: number | null;
  /**
   * Cumulative USDC refunded against this paymentId, two-decimal string.
   * "0.00" for the steady state (settled, no refund) — distinct from the
   * `null`-shaped fields above, which only go null when ReputationStorage
   * isn't configured. PaymentRouter is always configured, so we always
   * have a value here.
   */
  refundedUsdc: string;
  /**
   * 32-byte EAS attestation UID for the buyer's confirmation, when one has
   * been submitted via /confirm/:paymentId. Null when the buyer hasn't
   * confirmed yet (or for rows that pre-date migration 005). Consumers
   * deep-link to canonical attestations on EAS explorers with this.
   */
  confirmationAttestationUid: Hex | null;
}

function atomicToUsdc(atomic: string | number | bigint): string {
  return (Number(atomic) / 1_000_000).toFixed(2);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBoolean(v: unknown): boolean {
  return v === true;
}

interface RawSkill {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  metadata?: unknown;
}

/**
 * Pulls per-skill metadata using the same dual-shape strategy as
 * `discovery/format.ts:extractSkills`:
 *   A) skill.metadata[DASKI_A2A_EXTENSION_URI]
 *   B) extension.skills[skillId]
 * Skills present in the card but with no metadata are still emitted so the
 * UI can show their existence.
 */
function flattenSkills(agentCard: Record<string, unknown>): PublicSkill[] {
  const skills = agentCard["skills"];
  if (!Array.isArray(skills)) return [];

  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const shapeBMap =
    ext?.skills && typeof ext.skills === "object" && !Array.isArray(ext.skills)
      ? (ext.skills as Record<string, unknown>)
      : null;

  // Avoid hardcoding the extension URI here — the discovery formatter
  // imports it; we walk skill.metadata at runtime to find any object-typed
  // entry that looks like marketplace metadata.
  const out: PublicSkill[] = [];
  for (const raw of skills as RawSkill[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = asString(raw.id);
    if (!id) continue;

    let meta: Record<string, unknown> = {};
    if (raw.metadata && typeof raw.metadata === "object") {
      const shapeA = (raw.metadata as Record<string, unknown>)[
        DASKI_A2A_EXTENSION_URI
      ];
      if (shapeA && typeof shapeA === "object") {
        meta = shapeA as Record<string, unknown>;
      }
    }
    if (Object.keys(meta).length === 0 && shapeBMap) {
      const shapeB = shapeBMap[id];
      if (shapeB && typeof shapeB === "object") {
        meta = shapeB as Record<string, unknown>;
      }
    }

    const baseAmount = meta.baseAmount;
    // pricingModel may be a flat string (legacy) or a structured object
    // (current). Surface both: legacy string for back-compat, structured
    // detail (kind/source/hint) so the website can render integrator
    // hints like "live · quoted by registrar at purchase".
    const pricingModelRaw = meta.pricingModel;
    let pricingModelString: string | null = null;
    let pricingModelDetail: PublicSkillPricingModel | null = null;
    if (typeof pricingModelRaw === "string") {
      pricingModelString = pricingModelRaw;
    } else if (pricingModelRaw && typeof pricingModelRaw === "object") {
      const pm = pricingModelRaw as Record<string, unknown>;
      const kind = typeof pm.kind === "string" ? pm.kind : null;
      if (kind) {
        pricingModelString = kind;
        pricingModelDetail = {
          kind,
          source: typeof pm.source === "string" ? pm.source : null,
          hint: typeof pm.hint === "string" ? pm.hint : null,
        };
      }
    }
    const requiredFieldsRaw = meta.requiredFields;
    const requiredFields = Array.isArray(requiredFieldsRaw)
      ? requiredFieldsRaw.filter((f): f is string => typeof f === "string")
      : null;
    out.push({
      id,
      name: asString(raw.name) ?? id,
      description: asString(raw.description),
      basePrice:
        baseAmount !== undefined && baseAmount !== null
          ? atomicToUsdc(baseAmount as string | number | bigint)
          : null,
      pricingModel: pricingModelString,
      pricingModelDetail,
      variable: asBoolean(meta.variablePricing) || asBoolean(meta.variable),
      paymentRequired: meta.paymentRequired !== false, // default true
      requiredFields,
      requiresAssetOwnership: asBoolean(meta.requiresAssetOwnership),
      requiresCapability: asBoolean(meta.requiresCapability),
      assetType: asString(meta.assetType),
    });
  }
  return out;
}

/**
 * Flattens a cached provider into the public service shape. Returns null
 * if the provider has no marketplace extension — those aren't surfaced as
 * services on the UI (they may still exist as pure A2A agents on-chain,
 * but the marketplace site only renders priced services).
 */
export function formatServiceForPublic(
  provider: CachedProvider,
): PublicService | null {
  const ext = extractMarketplaceExtension(provider.agentCard);
  if (!ext) return null;

  const pricingExt = (ext.pricing ?? {}) as Record<string, unknown>;
  const baseAmount = pricingExt.baseAmount;
  const pricingModel = asString(pricingExt.model);
  const pricing: PublicServicePricing = {
    currency: asString(pricingExt.currency),
    basePrice:
      baseAmount !== undefined && baseAmount !== null
        ? atomicToUsdc(baseAmount as string | number | bigint)
        : null,
    pricingModel,
    variable:
      asBoolean(pricingExt.variable) || asBoolean(pricingExt.variablePricing),
    billingModel: asString(pricingExt.billingModel),
  };

  // Primary service identity. derivePrimaryServiceId walks the same skill
  // metadata the issuer path uses, so the website-side serviceId matches
  // what the X402Adapter binds the EIP-3009 nonce to at settle time.
  const primary = derivePrimaryServiceId(provider);

  return {
    agentId: provider.agentId.toString(),
    name: extractAgentCardName(provider.agentCard),
    providerAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    category: asString(ext.category),
    serviceDescription: asString(ext.serviceDescription),
    serviceLifecycle: asString(ext.serviceLifecycle),
    turnaroundEstimate: asString(ext.turnaroundEstimate),
    providerA2AUrl: extractAgentCardUrl(provider.agentCard),
    providerName: provider.providerName,
    providerDescription: provider.providerDescription,
    serviceId: primary?.serviceId ?? null,
    serviceSlug: primary?.serviceSlug ?? null,
    serviceVersion: primary?.serviceVersion ?? null,
    pricing,
    skills: flattenSkills(provider.agentCard),
  };
}

/**
 * Activity row for /public/v1/activity and the per-service `recentPurchases`
 * tail. Only paid challenges should be passed in — the formatter assumes
 * `transactionHash` and `verifiedAt` are populated.
 *
 * `providerName` is supplied by the caller (looked up against the cache);
 * passing null is fine and signals "provider no longer in cache".
 *
 * `record` is the on-chain ReputationStorage.getRecord lookup for the
 * challenge's paymentId. Pass null when:
 *   - the gateway has no ReputationStorage configured
 *   - the challenge has no paymentId (pre-paid legacy rows shouldn't reach
 *     this formatter, but be defensive)
 *   - the provider hasn't attested an outcome yet (contract returns a
 *     zero-init struct; the reader converts that to null)
 *
 * `refundedAtomic` is the cumulative refund tally for this paymentId from
 * PaymentRouter.refundedAmount (always-readable; defaults to 0n).
 */
export function formatActivityRow(
  challenge: StoredChallenge,
  providerName: string | null,
  record: ReputationRecord | null,
  refundedAtomic: bigint,
): PublicActivityRow {
  // Defensive: if a non-paid row leaks through, fall back to createdAt for
  // the timestamp. Better than emitting `null` and breaking the UI.
  const timestamp = (challenge.verifiedAt ?? challenge.createdAt).toISOString();
  return {
    txHash: (challenge.transactionHash ?? "0x") as Hex,
    buyerAgentId: challenge.buyerTokenId.toString(),
    providerAgentId: challenge.providerTokenId.toString(),
    providerName,
    amount: atomicToUsdc(challenge.amount),
    skillId: challenge.skillId,
    timestamp,
    outcome: record?.outcome ?? null,
    confirmation: record?.confirmation ?? "Pending",
    // bigint → number coercion is safe: fulfillmentSeconds is a wall-clock
    // delta capped by realistic provider turnaround (hours to days), well
    // within Number.MAX_SAFE_INTEGER.
    fulfillmentSeconds:
      record?.fulfillmentSeconds != null ? Number(record.fulfillmentSeconds) : null,
    refundedUsdc: atomicToUsdc(refundedAtomic),
    confirmationAttestationUid: challenge.confirmationAttestationUid,
  };
}
