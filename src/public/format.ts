import type {
  BuyerConfirmationLabel,
  ProviderReputation,
  ReputationRecord,
  ServiceReputation,
  TransactionOutcome,
} from "../chain/reader.js";
import {
  cardsOf,
  extractAgentCardName,
  extractAgentCardUrl,
  extractMarketplaceExtension,
  parseAgentSkills,
} from "../discovery/format.js";
import { derivePrimaryServiceId } from "../discovery/serviceIdentity.js";
import { buildServiceLegal } from "../legal/purchase.js";
import type { MarketplaceLegalUrls, ServiceLegal } from "../legal/types.js";
import type {
  CachedProvider,
  Hex,
  ProviderCard,
  StoredChallenge,
} from "../types.js";
import type {
  CategoryFamily,
  FulfillmentMode,
  ServiceType,
} from "../serviceTaxonomy.js";

// ── Value-weighted reputation ───────────────────────────────────────────
//
// USDC-value-weighted satisfaction defends against the $0.0001 self-
// attestation Sybil attack: an attacker who spends < $0.25 contributes
// zero signal, and above the floor the log curve gives diminishing
// marginal weight so a single deep-pocketed attester can't single-handedly
// dictate a provider's rate. See reputation_brief.md for the full
// justification.
//
// Floor: $0.25 USDC (250_000 atomic). Curve: log2(1 + amount / floor).
//   - $0.0001 → 0 (below floor)
//   - $0.25   → log2(2) = 1.0
//   - $1      → log2(5) ≈ 2.32
//   - $10     → log2(41) ≈ 5.36
//   - $100    → log2(401) ≈ 8.65
//   - $1,000  → log2(4001) ≈ 11.97
// The shape is gentler than log10 (used elsewhere in Web3 reputation work)
// — it preserves more signal for high-ticket transactions while still
// dampening the long tail.

/** Minimum USDC (atomic) for an attestation to contribute to buyer satisfaction. */
export const SATISFACTION_FLOOR_USDC_ATOMIC = 250_000n;

/**
 * Map a paid amount (atomic USDC) to a satisfaction-rate weight.
 *
 * Returns 0 for amounts strictly below the floor — those attestations are
 * still recorded on chain (per ERC-8004) but contribute zero weight to the
 * Daski-canonical aggregator. Returns `log2(1 + amount / floor)` otherwise.
 *
 * Pure function, no side effects; safe to call inline during aggregation.
 */
export function satisfactionWeight(amountAtomic: bigint): number {
  if (amountAtomic < SATISFACTION_FLOOR_USDC_ATOMIC) return 0;
  const ratio = Number(amountAtomic) / Number(SATISFACTION_FLOOR_USDC_ATOMIC);
  return Math.log2(1 + ratio);
}

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
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions: string[];
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
   * Provider website URL from the ERC-8004 registration file's
   * `external_url` (ERC-721/OpenSea homepage convention). Null when the
   * provider hasn't set PROVIDER_WEBSITE_URL. Distinct from
   * `providerA2AUrl` (the JSON-RPC endpoint); this one is what
   * marketplace UIs link the provider chip to.
   */
  providerWebsite: string | null;
  /**
   * Square icon for the provider's brand mark from the ERC-8004
   * registration file's `image` field (ERC-721 metadata convention).
   * Null when unset; the website falls back to a category-family icon.
   */
  iconUrl: string | null;
  legal: ServiceLegal;
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
  pricingModelDetail: PublicSkillPricingModel | null;
  variable: boolean;
  paymentRequired: boolean;
  fulfillmentMode: FulfillmentMode;
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
  /**
   * USDC-value-weighted buyer satisfaction over this scope's attested
   * paid transactions (computed off chain_events). Same numerator-
   * denominator shape as `buyerSatisfactionRate` but each attestation
   * contributes `satisfactionWeight(amount)` instead of 1. Null when no
   * attestations land above the $0.25 floor. This is the canonical
   * anti-Sybil display metric; the count-based `buyerSatisfactionRate`
   * remains alongside for transparency.
   */
  buyerSatisfactionRateByValue: number | null;
  /** Number of attestations contributing nonzero weight. */
  buyerSatisfactionRateByValueSampleSize: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  confirmedCount: number;
  notConfirmedCount: number;
  /**
   * Total USDC settled at this scope (provider-level for `reputation`,
   * service-level for `serviceReputation`), two-decimal string. Sourced
   * from chain_events.amount_atomic so direct-to-router and other-gateway
   * settlements are included. Always present; "0.00" when no settled
   * rows have landed yet.
   */
  totalSpentUsdc: string;
}

export function deriveProviderReputation(
  raw: ProviderReputation,
  totalSpentAtomic: bigint = 0n,
  weightedSatisfaction: ServiceWeightedSatisfaction = {
    rateByValue: null,
    sampleSize: 0,
  },
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
    buyerSatisfactionRateByValue: weightedSatisfaction.rateByValue,
    buyerSatisfactionRateByValueSampleSize: weightedSatisfaction.sampleSize,
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
  weightedSatisfaction: ServiceWeightedSatisfaction = {
    rateByValue: null,
    sampleSize: 0,
  },
): PublicServiceLevelReputation {
  // ServiceReputation is structurally a superset of ProviderReputation
  // (same five outcome counters plus totalRefunded), so the existing
  // derivation works unchanged. Off-chain enrichment (fulfillment mean,
  // weighted satisfaction, total spent) is passed in by the caller and
  // forwarded to `deriveProviderReputation` for the shared fields.
  return {
    ...deriveProviderReputation(raw, totalSpentAtomic, weightedSatisfaction),
    totalRefundedUsdc: atomicToUsdc(raw.totalRefunded),
    serviceId,
    averageFulfillmentSeconds: fulfillment.averageFulfillmentSeconds,
    fulfillmentSampleSize: fulfillment.sampleSize,
  };
}

// ── Per-skill stats + service-level weighted satisfaction ──────────────
//
// PublicSkillStats is the per-skill breakdown of the same metrics the
// service-level view exposes — counts, completion/satisfaction/refund
// rates, and median/P90 fulfillment time — but grouped by the buyer's
// stated `skillId`. The grouping is gateway-DB-scoped (rows the chain
// settled but this gateway didn't issue won't appear).
//
// Why per-skill matters: a domain-management service might offer
// `register-domain` (60-second turnaround, 0% refund) and `transfer-out`
// (multi-day turnaround, higher refund rate). Service-level aggregates
// average across both and produce a misleading "3-day median" that
// neither skill actually reflects. Per-skill breaks that out.

/** Aggregated stats for one skillId under one service. */
export interface PublicSkillStats {
  skillId: string;
  /** Display name from the provider's AgentCard catalog; null if unresolvable. */
  skillName: string | null;
  /** Settled paid transactions for this skill. */
  totalTransactions: number;
  /** USDC, two-decimal string. Sum across all paid rows for this skill. */
  totalSpentUsdc: string;
  /** Distinct buyer agentIds. Sybil heuristic: high txns / low buyers = concentrated. */
  uniqueBuyerCount: number;
  // Per-outcome counts (provider attested on chain)
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  /** completed / (completed + failed + canceled). Null if no outcomes recorded. */
  completionRate: number | null;
  // Per-confirmation counts (buyer attested on chain)
  confirmedCount: number;
  notConfirmedCount: number;
  /** Paid rows where the buyer never attested. */
  pendingConfirmationCount: number;
  /** confirmed / (confirmed + notConfirmed). Count-based. Null if no attestations. */
  buyerSatisfactionRate: number | null;
  /**
   * USDC-value-weighted satisfaction. Each attestation contributes
   * `satisfactionWeight(amount)`; below-floor attestations contribute 0.
   * Null if no attestations land above the floor.
   */
  buyerSatisfactionRateByValue: number | null;
  /** Median (P50) fulfillment time in seconds; null if no fulfilled samples. */
  medianFulfillmentSeconds: number | null;
  /** P90 fulfillment time in seconds; null if no fulfilled samples. */
  p90FulfillmentSeconds: number | null;
  /** Number of records contributing to the fulfillment quantiles. */
  fulfillmentSampleSize: number;
  /** Cumulative USDC refunded across all paymentIds for this skill. */
  refundedUsdc: string;
  /** Number of paymentIds with refundedAmount > 0. */
  refundCount: number;
  /** refundCount / completedCount. Null if no completed transactions. */
  refundRate: number | null;
}

/** Service-level USDC-value-weighted satisfaction (aggregate across all skills). */
export interface ServiceWeightedSatisfaction {
  rateByValue: number | null;
  sampleSize: number;
}

/** One paid challenge row joined with its on-chain enrichment. */
export interface SkillEnrichedRow {
  challenge: StoredChallenge;
  record: ReputationRecord | null;
  refundedAtomic: bigint;
}

/**
 * Group enriched paid challenges by skillId and compute per-skill
 * aggregates. Pure function — caller pre-fetches `record` and
 * `refundedAtomic` (typically via cached chain reads) so this can be
 * called inside a request handler without further I/O.
 *
 * Rows with null/empty skillId are dropped (pre-skill-resolution
 * history can't be attributed cleanly). Output is sorted by
 * `totalTransactions` descending, with skillId as the tiebreaker.
 */
export function deriveSkillStats(
  rows: ReadonlyArray<SkillEnrichedRow>,
  skillNames: ReadonlyMap<string, string> = new Map(),
): PublicSkillStats[] {
  const groups = new Map<string, SkillEnrichedRow[]>();
  for (const row of rows) {
    const skillId = row.challenge.skillId;
    if (!skillId) continue;
    const list = groups.get(skillId);
    if (list) list.push(row);
    else groups.set(skillId, [row]);
  }

  const out: PublicSkillStats[] = [];
  for (const [skillId, list] of groups) {
    out.push(
      aggregateSkillRows(skillId, list, skillNames.get(skillId) ?? null),
    );
  }
  out.sort(
    (a, b) =>
      b.totalTransactions - a.totalTransactions ||
      a.skillId.localeCompare(b.skillId),
  );
  return out;
}

function aggregateSkillRows(
  skillId: string,
  rows: SkillEnrichedRow[],
  skillName: string | null,
): PublicSkillStats {
  let totalSpentAtomic = 0n;
  let refundedAtomic = 0n;
  let refundCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let canceledCount = 0;
  let confirmedCount = 0;
  let notConfirmedCount = 0;
  let pendingConfirmationCount = 0;
  let weightedConfirmed = 0;
  let weightedAttested = 0;
  const fulfillmentSamples: number[] = [];
  const uniqueBuyers = new Set<string>();

  for (const row of rows) {
    totalSpentAtomic += row.challenge.amount;
    uniqueBuyers.add(row.challenge.buyerTokenId.toString());
    if (row.refundedAtomic > 0n) {
      refundedAtomic += row.refundedAtomic;
      refundCount++;
    }
    const rec = row.record;
    if (rec?.outcomeRecorded) {
      if (rec.outcome === "Completed") completedCount++;
      else if (rec.outcome === "Failed") failedCount++;
      else if (rec.outcome === "Canceled") canceledCount++;
      if (rec.fulfillmentSeconds != null) {
        fulfillmentSamples.push(Number(rec.fulfillmentSeconds));
      }
    }
    const conf = rec?.confirmation ?? "Pending";
    if (conf === "Confirmed") {
      confirmedCount++;
      const w = satisfactionWeight(row.challenge.amount);
      weightedConfirmed += w;
      weightedAttested += w;
    } else if (conf === "NotConfirmed") {
      notConfirmedCount++;
      const w = satisfactionWeight(row.challenge.amount);
      weightedAttested += w;
    } else {
      pendingConfirmationCount++;
    }
  }

  const totalOutcomes = completedCount + failedCount + canceledCount;
  const totalAttested = confirmedCount + notConfirmedCount;

  return {
    skillId,
    skillName,
    totalTransactions: rows.length,
    totalSpentUsdc: atomicToUsdc(totalSpentAtomic),
    uniqueBuyerCount: uniqueBuyers.size,
    completedCount,
    failedCount,
    canceledCount,
    completionRate: totalOutcomes > 0 ? completedCount / totalOutcomes : null,
    confirmedCount,
    notConfirmedCount,
    pendingConfirmationCount,
    buyerSatisfactionRate:
      totalAttested > 0 ? confirmedCount / totalAttested : null,
    buyerSatisfactionRateByValue:
      weightedAttested > 0 ? weightedConfirmed / weightedAttested : null,
    medianFulfillmentSeconds: quantile(fulfillmentSamples, 0.5),
    p90FulfillmentSeconds: quantile(fulfillmentSamples, 0.9),
    fulfillmentSampleSize: fulfillmentSamples.length,
    refundedUsdc: atomicToUsdc(refundedAtomic),
    refundCount,
    refundRate: completedCount > 0 ? refundCount / completedCount : null,
  };
}

/**
 * Service-level USDC-value-weighted satisfaction. Same denominator
 * semantics as the per-skill version but pooled across all skills,
 * so the response can headline a single weighted rate alongside the
 * per-skill breakdown.
 */
export function deriveServiceWeightedSatisfaction(
  rows: ReadonlyArray<SkillEnrichedRow>,
): ServiceWeightedSatisfaction {
  let weightedConfirmed = 0;
  let weightedAttested = 0;
  let sampleSize = 0;
  for (const row of rows) {
    const conf = row.record?.confirmation;
    if (conf !== "Confirmed" && conf !== "NotConfirmed") continue;
    const w = satisfactionWeight(row.challenge.amount);
    if (w === 0) continue;
    if (conf === "Confirmed") weightedConfirmed += w;
    weightedAttested += w;
    sampleSize++;
  }
  return {
    rateByValue:
      weightedAttested > 0 ? weightedConfirmed / weightedAttested : null,
    sampleSize,
  };
}

/**
 * Linear-interpolated quantile over an unsorted samples array.
 * Returns null when the input is empty; otherwise rounds to whole
 * seconds (the caller's data unit). Quantile choice (vs. raw mean)
 * is robust to fat-tail fulfillment distributions — e.g. one stuck
 * transfer-out that takes a week doesn't dominate the P50 the way
 * it dominates a mean.
 */
function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return Math.round(sorted[lo]);
  const frac = pos - lo;
  return Math.round(sorted[lo] * (1 - frac) + sorted[hi] * frac);
}

/**
 * Aggregated stats for a single buyer agentId. Sourced entirely from
 * `chain_events` (one query, no RPC): outcome and confirmation counts
 * come from the indexer's mirror of `PaymentSettled` + the periodic
 * outcome/confirmation/refund refresh, so the buyer endpoint hits zero
 * RPCs at request time. The on-chain `getBuyerStats` view would give
 * the same counters but with an extra read and a one-block lag.
 */
export interface PublicBuyerReputation {
  /** Settled transactions involving this buyer (chain_events rows). */
  transactions: number;

  // Confirmation counters (buyer's own attestations via /confirm)
  confirmedCount: number;
  notConfirmedCount: number;
  /** Settled rows where the buyer has not yet attested. */
  pendingConfirmationCount: number;
  /** confirmed / (confirmed + notConfirmed). Null if the buyer has never attested. */
  attestationRate: number | null;
  /**
   * (confirmed + notConfirmed) / transactions. Useful as a "does this
   * buyer follow through with feedback" signal. Null when transactions == 0.
   */
  attestationCoverage: number | null;

  // Outcome counters (provider-attested via EAS, mirrored from
  // ReputationStorage into chain_events.outcome).
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  /** completed / (completed + failed + canceled). Null when no outcomes recorded. */
  completionRate: number | null;

  /** USDC, two-decimal string. Sum across all settled rows. */
  totalSpentUsdc: string;
  /** Mean of `totalSpentUsdc / transactions`, two-decimal. "0.00" when transactions == 0. */
  averageTransactionUsdc: string;
  /** Cumulative USDC refunded back to this buyer across all paymentIds. */
  totalRefundedUsdc: string;
  /** refundCount / transactions. Null when no transactions. */
  refundReceivedRate: number | null;

  /** Distinct provider agentIds the buyer has settled with. */
  uniqueProviderCount: number;
  /** Distinct skillIds across the buyer's gateway-issued purchases (LEFT JOIN payment_challenges). */
  uniqueSkillCount: number;

  /** Mean fulfillment in whole seconds across attested outcomes; null if none. */
  averageFulfillmentSeconds: number | null;
  /** Records contributing to the mean (rows with non-null fulfillment_seconds). */
  fulfillmentSampleSize: number;
}

/** Raw aggregate shape returned by `aggregateChainActivityByBuyer`. */
export interface BuyerActivityAggregate {
  transactionCount: number;
  totalSpentAtomic: bigint;
  totalRefundedAtomic: bigint;
  refundCount: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  confirmedCount: number;
  notConfirmedCount: number;
  uniqueProviderCount: number;
  uniqueSkillCount: number;
  fulfillmentSumSeconds: number;
  fulfillmentSampleSize: number;
}

/**
 * Pure derivation: turn the DB aggregate into the wire shape. Lives
 * here rather than in the route so tests can lock the rate math and
 * formatting without standing up Postgres.
 */
export function derivePublicBuyerReputation(
  agg: BuyerActivityAggregate,
): PublicBuyerReputation {
  const {
    transactionCount,
    totalSpentAtomic,
    totalRefundedAtomic,
    refundCount,
    completedCount,
    failedCount,
    canceledCount,
    confirmedCount,
    notConfirmedCount,
    uniqueProviderCount,
    uniqueSkillCount,
    fulfillmentSumSeconds,
    fulfillmentSampleSize,
  } = agg;
  const attested = confirmedCount + notConfirmedCount;
  const outcomes = completedCount + failedCount + canceledCount;
  const averageAtomic =
    transactionCount > 0
      ? totalSpentAtomic / BigInt(transactionCount)
      : 0n;
  return {
    transactions: transactionCount,
    confirmedCount,
    notConfirmedCount,
    pendingConfirmationCount: Math.max(0, transactionCount - attested),
    attestationRate: attested > 0 ? confirmedCount / attested : null,
    attestationCoverage:
      transactionCount > 0 ? attested / transactionCount : null,
    completedCount,
    failedCount,
    canceledCount,
    completionRate: outcomes > 0 ? completedCount / outcomes : null,
    totalSpentUsdc: atomicToUsdc(totalSpentAtomic),
    averageTransactionUsdc: atomicToUsdc(averageAtomic),
    totalRefundedUsdc: atomicToUsdc(totalRefundedAtomic),
    refundReceivedRate:
      transactionCount > 0 ? refundCount / transactionCount : null,
    uniqueProviderCount,
    uniqueSkillCount,
    averageFulfillmentSeconds:
      fulfillmentSampleSize > 0
        ? Math.round(fulfillmentSumSeconds / fulfillmentSampleSize)
        : null,
    fulfillmentSampleSize,
  };
}

/** Detail response from `GET /public/v1/buyers/:agentId`. */
export interface PublicBuyerDetail {
  agentId: string;
  /** ERC-8004 wallet, lowercase. Null when the IdentityRegistry read failed
   *  and no buyer_identities row was cached at registration time. */
  walletAddress: Hex | null;
  /** Display name from buyer_identities (cached at registration) or, if
   *  unavailable, resolved live via tokenURI; falls back to `buyer-<last6>`. */
  name: string | null;
  /** Mirror of the on-chain agentURI when known; null otherwise. */
  agentURI: string | null;
  /** ISO-8601; null when the buyer has no settled rows yet. */
  firstPurchaseAt: string | null;
  /** ISO-8601; null when the buyer has no settled rows yet. */
  lastPurchaseAt: string | null;
  reputation: PublicBuyerReputation;
  recentPurchases: PublicActivityRow[];
}

/** One entry in the `GET /public/v1/buyers` leaderboard. */
export interface PublicBuyerSummary {
  agentId: string;
  /** Resolved name from buyer_identities, or null (UI falls back to `agent#<id>`). */
  name: string | null;
  /** USDC, two-decimal string. Lifetime spend. */
  totalSpentUsdc: string;
  transactionCount: number;
  /** ISO-8601 timestamp of the most-recent settled transaction. */
  lastPurchaseAt: string;
}

export interface PublicActivityRow {
  /** Always set — only paid rows are emitted. */
  txHash: Hex;
  buyerAgentId: string;
  providerAgentId: string;
  /** Provider's primary Agent Card name. NOTE: for a multi-service
   *  provider this is the headline/primary card, NOT the specific service
   *  bought — use `serviceName` for the actual offering. Null if the
   *  provider was deregistered or removed from the whitelist since this
   *  row landed. */
  providerName: string | null;
  /**
   * The specific service this purchase settled against, resolved from the
   * provider's service catalog by the row's on-chain `serviceId` (falling
   * back to `serviceSlug`). A provider may offer several services; this
   * names the one actually bought. Null when the service is no longer in
   * the discovery cache.
   */
  serviceName: string | null;
  /** Slug of the purchased service — stable id within the provider, pairs
   *  with `providerAgentId` to deep-link the service page. Null for
   *  chain-only rows with no resolvable service. */
  serviceSlug: string | null;
  /** 32-byte on-chain serviceId of the purchased service. */
  serviceId: Hex;
  /**
   * Display name resolved from the buyer's ERC-8004 IdentityRegistry
   * tokenURI metadata (`metadata.name`). Null when the buyer's NFT has no
   * resolvable name, the metadata fetch failed, or the IdentityRegistry
   * read errored — surfaces are designed to render `agent#<id>` in that
   * case rather than break. Provider-side equivalent is `providerName`.
   */
  buyerName: string | null;
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

/** Build the public skill view from the canonical card parser. */
function flattenSkills(agentCard: Record<string, unknown>): PublicSkill[] {
  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;

  const out: PublicSkill[] = [];
  for (const raw of parseAgentSkills(agentCard)) {
    const { id, metadata: meta } = raw;

    // baseAmount lives at the metadata top level in older cards, but
    // daski-provider nests it under meta.pricing (the translated per-skill
    // pricing block). A nested "0" is the live-priced floor, not a price —
    // treat it as absent.
    const nestedPricing =
      meta.pricing && typeof meta.pricing === "object"
        ? (meta.pricing as Record<string, unknown>)
        : null;
    const nestedBase =
      nestedPricing?.baseAmount !== undefined &&
      nestedPricing?.baseAmount !== null &&
      String(nestedPricing.baseAmount) !== "0"
        ? nestedPricing.baseAmount
        : undefined;
    const baseAmount = meta.baseAmount ?? nestedBase;
    // Structured pricing metadata lets clients describe quote-driven
    // services without overloading the fixed base-price field.
    const pricingModelRaw = meta.pricingModel;
    let pricingModelDetail: PublicSkillPricingModel | null = null;
    if (pricingModelRaw && typeof pricingModelRaw === "object") {
      const pm = pricingModelRaw as Record<string, unknown>;
      const kind = typeof pm.kind === "string" ? pm.kind : null;
      if (kind) {
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
      pricingModelDetail,
      variable: asBoolean(meta.variablePricing) || asBoolean(meta.variable),
      paymentRequired: meta.paymentRequired !== false, // default true
      fulfillmentMode: asString(
        meta.fulfillmentMode ?? ext?.fulfillmentMode,
      ) as FulfillmentMode,
      requiredFields,
      requiresAssetOwnership: asBoolean(meta.requiresAssetOwnership),
      requiresCapability: asBoolean(meta.requiresCapability),
      assetType: asString(meta.assetType),
    });
  }
  return out;
}

/**
 * Flattens ONE of a provider's cards into the public service shape.
 * Returns null if the card has no marketplace extension — those aren't
 * surfaced as services on the UI (they may still exist as pure A2A
 * agents on-chain, but the marketplace site only renders priced
 * services).
 */
function formatServiceCardForPublic(
  provider: CachedProvider,
  card: ProviderCard,
  marketplace: MarketplaceLegalUrls,
): PublicService | null {
  const ext = extractMarketplaceExtension(card.agentCard);
  if (!ext || !provider.providerLegal) return null;

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

  // Service identity for THIS card. derivePrimaryServiceId walks the same
  // skill metadata the issuer path uses, so the website-side serviceId
  // matches what the X402Adapter binds the EIP-3009 nonce to at settle
  // time. Scoping the provider view to the single card keeps the
  // derivation per-service on multi-service providers.
  const primary = derivePrimaryServiceId({
    ...provider,
    cards: [card],
  });

  return {
    agentId: provider.agentId.toString(),
    name: extractAgentCardName(card.agentCard),
    providerAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    categoryFamily: ext.categoryFamily,
    serviceType: ext.serviceType,
    jurisdictions: ext.jurisdictions,
    serviceDescription: asString(ext.serviceDescription),
    serviceLifecycle: asString(ext.serviceLifecycle),
    turnaroundEstimate: asString(ext.turnaroundEstimate),
    providerA2AUrl: extractAgentCardUrl(card.agentCard),
    providerName: provider.providerName,
    providerDescription: provider.providerDescription,
    providerWebsite: provider.providerExternalUrl,
    iconUrl: provider.providerImage,
    legal: buildServiceLegal(marketplace, provider.providerLegal),
    serviceId: primary?.serviceId ?? null,
    serviceSlug: primary?.serviceSlug ?? null,
    serviceVersion: primary?.serviceVersion ?? null,
    pricing,
    skills: flattenSkills(card.agentCard),
  };
}

/**
 * Every public service a provider offers — one entry per Agent Card.
 * Single-service providers yield exactly one entry (unchanged shape).
 */
export function formatServicesForPublic(
  provider: CachedProvider,
  marketplace: MarketplaceLegalUrls,
): PublicService[] {
  const out: PublicService[] = [];
  for (const card of cardsOf(provider)) {
    const formatted = formatServiceCardForPublic(provider, card, marketplace);
    if (formatted) out.push(formatted);
  }
  return out;
}

/**
 * Activity row for /public/v1/activity and the per-service `recentPurchases`
 * tail. Only paid challenges should be passed in — the formatter assumes
 * `transactionHash` and `verifiedAt` are populated.
 *
 * `providerName` is supplied by the caller (looked up against the cache);
 * passing null is fine and signals "provider no longer in cache".
 *
 * `buyerName` is the symmetric field for the buyer — resolved from the
 * buyer's IdentityRegistry tokenURI metadata. Pass null when the route's
 * resolver couldn't load a name (unreachable agentURI, malformed JSON,
 * missing `name` field); the UI degrades to `agent#<id>`.
 *
 * `record` is the on-chain ReputationStorage.getRecord lookup for the
 * challenge's paymentId. Pass null when:
 *   - the gateway has no ReputationStorage configured
 *   - the challenge has no paymentId
 *   - the provider hasn't attested an outcome yet (contract returns a
 *     zero-init struct; the reader converts that to null)
 *
 * `refundedAtomic` is the cumulative refund tally for this paymentId from
 * PaymentRouter.refundedAmount (always-readable; defaults to 0n).
 */
/**
 * Formatter for chain-events sourced rows. skillId and
 * confirmationAttestationUid can be null for chain-only rows settled
 * outside this gateway, without a database row to enrich from.
 *
 * Outcome / confirmation codes (0/1/2) map to the Solidity enum order
 * used by ReputationStorage. See indexer/chainEvents.ts for the
 * reverse mapping at write time.
 */
export function formatChainActivityRow(
  row: import("../db/queries.js").ChainActivityRow,
  providerName: string | null,
  serviceName: string | null,
  buyerName: string | null,
): PublicActivityRow {
  const outcomeLabels: readonly TransactionOutcome[] = [
    "Completed",
    "Failed",
    "Canceled",
  ];
  const confirmationLabels: readonly BuyerConfirmationLabel[] = [
    "Pending",
    "Confirmed",
    "NotConfirmed",
  ];
  return {
    txHash: row.txHash,
    buyerAgentId: row.buyerAgentId.toString(),
    providerAgentId: row.providerAgentId.toString(),
    providerName,
    serviceName,
    serviceSlug: row.serviceSlug,
    serviceId: row.serviceId,
    buyerName,
    amount: atomicToUsdc(row.amountAtomic),
    skillId: row.skillId,
    timestamp: row.settledAt.toISOString(),
    outcome: row.outcomeCode != null ? outcomeLabels[row.outcomeCode] : null,
    confirmation: confirmationLabels[row.confirmationCode] ?? "Pending",
    fulfillmentSeconds: row.fulfillmentSeconds,
    refundedUsdc: atomicToUsdc(row.refundedAtomic),
    confirmationAttestationUid: row.confirmationAttestationUid,
  };
}
