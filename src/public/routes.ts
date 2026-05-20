import { Router, type Request, type Response } from "express";
import type {
  BuyerConfirmationLabel,
  ChainReader,
  ReputationRecord,
  TransactionOutcome,
} from "../chain/reader.js";
import type { Config } from "../config.js";
import type { ChainActivityRow, Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { extractAgentCardName } from "../discovery/format.js";
import {
  fetchAgentCard,
  type FetchAgentCardOptions,
} from "../identity/fetch-agent-card.js";
import {
  derivePublicBuyerReputation,
  deriveProviderReputation,
  deriveServiceReputation,
  deriveServiceWeightedSatisfaction,
  deriveSkillStats,
  formatActivityRow,
  formatChainActivityRow,
  formatServiceForPublic,
  type PublicBuyerDetail,
  type PublicBuyerReputation,
  type PublicBuyerSummary,
  type PublicService,
  type PublicServiceLevelReputation,
  type PublicServiceReputation,
  type PublicSkillStats,
  type ServiceWeightedSatisfaction,
  type SkillEnrichedRow,
} from "./format.js";
import type { Hex, StoredChallenge } from "../types.js";

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;
const PER_SERVICE_RECENT_LIMIT = 10;
const PER_BUYER_RECENT_LIMIT = 10;
const BUYER_LEADERBOARD_DEFAULT_LIMIT = 25;
const BUYER_LEADERBOARD_MAX_LIMIT = 100;

/**
 * Block number cache. /public/v1/stats is intended to be polled by the
 * marketing site for the live block-height ticker; without a small TTL
 * each visitor would translate 1:1 into RPC reads. Two seconds matches
 * Base's block time and matches the design's client-side tick cadence,
 * so the value is never visibly stale. On RPC failure we fall back to
 * the last known value rather than 5xx-ing — a brief flatline is far
 * less disruptive to the marketing site than a hard error.
 */
class BlockNumberCache {
  private value: bigint = 0n;
  private fetchedAt = 0;
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    ttlMs = 2000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(): Promise<bigint> {
    const now = Date.now();
    if (now - this.fetchedAt < this.ttlMs && this.fetchedAt > 0) {
      return this.value;
    }
    try {
      this.value = await this.reader.getBlockNumber();
      this.fetchedAt = now;
    } catch {
      // Keep last known value; fetchedAt stays unchanged so we retry next call.
    }
    return this.value;
  }
}

/**
 * Per-agentId cache for provider reputation. Same shape as BlockNumberCache
 * but keyed: each service-detail page hit otherwise translates 1:1 into an
 * RPC read against ReputationStorage. 30s TTL is well below the cadence at
 * which counters move (each tick requires a real on-chain attestation), so
 * no user perceives staleness.
 *
 * On RPC failure: serve the last known value if we have one, else null. The
 * route's empty-state already handles null — a brief flatline is far less
 * disruptive than a hard 5xx for a marketing-side surface.
 */
class ProviderReputationCache {
  private readonly entries = new Map<
    string,
    { value: PublicServiceReputation | null; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly sampleLimit: number,
    ttlMs = 30_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(agentId: bigint): Promise<PublicServiceReputation | null> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      // Three reads in parallel:
      //   - on-chain counters (getProviderReputation) for the
      //     count-based rates and the raw counters surfaced for
      //     transparency;
      //   - chain_events spend aggregate for the dollar volume;
      //   - chain_events sample for the off-chain value-weighted
      //     satisfaction rate. Same shape as ServiceAggregatesCache
      //     but provider-scoped.
      const [raw, spend, chainRows] = await Promise.all([
        this.reader.getProviderReputation(agentId),
        this.queries.getProviderSpend(agentId),
        this.queries.listRecentChainActivityByProvider(
          agentId,
          this.sampleLimit,
        ),
      ]);
      if (!raw) {
        this.entries.set(key, { value: null, fetchedAt: now });
        return null;
      }
      const weighted = deriveServiceWeightedSatisfaction(
        chainRows.map(chainRowToSkillEnriched),
      );
      const value = deriveProviderReputation(raw, spend.totalAtomic, weighted);
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? null;
    }
  }
}

/**
 * Per-serviceId cache for service-scoped reputation. Same shape as
 * ProviderReputationCache but keyed by 32-byte serviceId so multiple
 * services owned by the same provider don't collide. 30s TTL matches the
 * provider-level cache and the cadence at which counters move (each tick
 * requires a real on-chain attestation).
 */
class ServiceReputationCache {
  private readonly entries = new Map<
    string,
    { value: PublicServiceLevelReputation | null; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    ttlMs = 30_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(serviceId: Hex): Promise<PublicServiceLevelReputation | null> {
    const key = serviceId.toLowerCase();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      // Service counters + per-service spend in parallel (same rationale
      // as ProviderReputationCache). Fulfillment is intentionally NOT
      // bundled here — it has a heavier fan-out path and its own cache.
      const [raw, spend] = await Promise.all([
        this.reader.getServiceReputation(serviceId),
        this.queries.getServiceSpend(serviceId),
      ]);
      const value = raw
        ? deriveServiceReputation(raw, serviceId, undefined, spend.totalAtomic)
        : null;
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? null;
    }
  }
}

/**
 * Per-paymentId cache for `ReputationStorage.getRecord`. Activity rows
 * fan out one read per row otherwise — at the 200-row cap that's a 200-RPC
 * burst per cold page load. 60s TTL is loose enough that warm reloads cost
 * nothing and tight enough that newly-attested outcomes surface promptly.
 *
 * Records are largely append-once (outcome attestations are not revocable
 * per the resolver), so a generous TTL is safe; the buyer-confirmation
 * field is the only mutable part and tolerates a minute of staleness.
 */
class ReputationRecordCache {
  private readonly entries = new Map<
    string,
    { value: ReputationRecord | null; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    ttlMs = 60_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(paymentId: bigint): Promise<ReputationRecord | null> {
    const key = paymentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const value = await this.reader.getReputationRecord(paymentId);
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? null;
    }
  }
}

/**
 * Per-paymentId cache for `PaymentRouter.refundedAmount`. Unlike outcome
 * records (which are append-once), refunds can land at any time and the
 * cumulative tally moves with each one — so the TTL is tighter (30s) to
 * keep partial-refund displays from lagging too far behind. On RPC failure
 * fall back to 0n rather than null so the formatter always renders a
 * dollar string (the field is non-nullable; "0.00" is the safe default).
 */
class RefundAmountCache {
  private readonly entries = new Map<
    string,
    { value: bigint; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    ttlMs = 30_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(paymentId: bigint): Promise<bigint> {
    const key = paymentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const value = await this.reader.getPaymentRefundedAmount(paymentId);
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? 0n;
    }
  }
}

/** Per-serviceId aggregate value: fulfillment + weighted satisfaction + per-skill breakdown. */
interface ServiceAggregatesValue {
  fulfillment: { averageFulfillmentSeconds: number | null; sampleSize: number };
  weightedSatisfaction: ServiceWeightedSatisfaction;
  /** Per-skill stats with skillName fields left null — caller fills from AgentCard catalog. */
  skillStats: PublicSkillStats[];
}

/**
 * Per-serviceId cache for all off-chain-computed service aggregates:
 *   - mean fulfillment time (legacy `ServiceFulfillmentCache` behaviour)
 *   - USDC-value-weighted buyer satisfaction (anti-Sybil reputation)
 *   - per-skill breakdown of counts, rates, refunds, and fulfillment quantiles
 *
 * One fetch pass, one cache, one TTL — these aggregates all derive from
 * the same `(paid challenges) × (per-record on-chain enrichment)` data,
 * so doing them separately would multiply RPC fan-out for no benefit.
 *
 * Reuses the supplied recordCache and refundCache so per-paymentId reads
 * warm both this aggregate and the activity-row enrichment in the same
 * response. 60s TTL: aggregates move slowly (a single new transaction
 * shifts each metric by ~1/N), so consumers can poll without thrashing
 * the RPC.
 *
 * Skill names are intentionally NOT resolved here — the cache is keyed
 * by serviceId, but skill names live on the provider's AgentCard
 * catalog. Resolving them here would couple the cache to discovery
 * cache state. Callers do a final `.map(s => ({ ...s, skillName }))`
 * pass after the cache returns.
 */
class ServiceAggregatesCache {
  private readonly entries = new Map<
    string,
    { value: ServiceAggregatesValue; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly queries: Queries,
    private readonly sampleLimit: number,
    ttlMs = 60_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(serviceId: Hex): Promise<ServiceAggregatesValue> {
    const key = serviceId.toLowerCase();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;

    let chainRows: ChainActivityRow[];
    try {
      chainRows = await this.queries.listRecentChainActivityByServiceId(
        serviceId,
        this.sampleLimit,
      );
    } catch {
      // DB failure: return previous value if any, else an empty default
      // so the UI doesn't show stale or broken state.
      return hit?.value ?? EMPTY_AGGREGATES;
    }

    // chain_events already carries outcome / confirmation / fulfillment
    // / refunded for every row (the indexer fetches them at write time
    // and the refresh sweep keeps them current). Bridge to the
    // SkillEnrichedRow shape the derive helpers consume — they take
    // {challenge, record, refundedAtomic} so we synthesize a thin
    // StoredChallenge from chain_events fields.
    const rows = chainRows.map(chainRowToSkillEnriched);

    let sumSec = 0;
    let fulfilledCount = 0;
    for (const r of rows) {
      if (r.record?.outcomeRecorded && r.record.fulfillmentSeconds != null) {
        sumSec += Number(r.record.fulfillmentSeconds);
        fulfilledCount++;
      }
    }

    const value: ServiceAggregatesValue = {
      fulfillment: {
        averageFulfillmentSeconds:
          fulfilledCount > 0 ? Math.round(sumSec / fulfilledCount) : null,
        sampleSize: fulfilledCount,
      },
      weightedSatisfaction: deriveServiceWeightedSatisfaction(rows),
      skillStats: deriveSkillStats(rows),
    };
    this.entries.set(key, { value, fetchedAt: now });
    return value;
  }
}

const OUTCOME_LABELS: readonly TransactionOutcome[] = [
  "Completed",
  "Failed",
  "Canceled",
];
const CONFIRMATION_LABELS: readonly BuyerConfirmationLabel[] = [
  "Pending",
  "Confirmed",
  "NotConfirmed",
];
const ZERO_HEX = ("0x" + "00".repeat(32)) as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

/**
 * Bridge `chain_events`-shaped rows into the `SkillEnrichedRow` shape the
 * pure-function derive helpers consume. The challenge fields not present
 * in chain_events default to sensible zeros — `aggregateSkillRows` only
 * reads amount / buyerTokenId / skillId / record / refundedAtomic, so
 * the rest never matter.
 */
function chainRowToSkillEnriched(row: ChainActivityRow): SkillEnrichedRow {
  const record: ReputationRecord | null =
    row.outcomeCode != null
      ? {
          paymentId: row.paymentId,
          providerAgentId: row.providerAgentId,
          buyerAgentId: row.buyerAgentId,
          serviceId: row.serviceId,
          outcome: OUTCOME_LABELS[row.outcomeCode] ?? null,
          confirmation:
            CONFIRMATION_LABELS[row.confirmationCode] ?? "Pending",
          fulfillmentSeconds:
            row.fulfillmentSeconds != null
              ? BigInt(row.fulfillmentSeconds)
              : null,
          outcomeTimestamp: 0n,
          confirmationTimestamp: 0n,
          outcomeRecorded: true,
        }
      : {
          // No outcome attested yet — synthesize a Pending record so the
          // confirmation label still surfaces.
          paymentId: row.paymentId,
          providerAgentId: row.providerAgentId,
          buyerAgentId: row.buyerAgentId,
          serviceId: row.serviceId,
          outcome: null,
          confirmation:
            CONFIRMATION_LABELS[row.confirmationCode] ?? "Pending",
          fulfillmentSeconds: null,
          outcomeTimestamp: 0n,
          confirmationTimestamp: 0n,
          outcomeRecorded: false,
        };
  return {
    challenge: {
      serviceRef: ZERO_HEX,
      providerTokenId: row.providerAgentId,
      buyerTokenId: row.buyerAgentId,
      amount: row.amountAtomic,
      skillId: row.skillId,
      serviceSlug: row.serviceSlug ?? "",
      serviceVersion: row.serviceVersion ?? "1",
      serviceId: row.serviceId,
      providerA2AUrl: row.providerA2AUrl ?? "",
      walletAddress: row.walletAddress ?? ZERO_ADDRESS,
      createdAt: row.settledAt,
      expiresAt: row.settledAt,
      status: "paid",
      paymentId: row.paymentId,
      transactionHash: row.txHash,
      verifiedAt: row.settledAt,
      confirmationAttestationUid: row.confirmationAttestationUid,
    },
    record,
    refundedAtomic: row.refundedAtomic,
  };
}

const EMPTY_AGGREGATES: ServiceAggregatesValue = {
  fulfillment: { averageFulfillmentSeconds: null, sampleSize: 0 },
  weightedSatisfaction: { rateByValue: null, sampleSize: 0 },
  skillStats: [],
};

// Default sample window for the per-service aggregates. 200 keeps a
// cold-load fan-out under 200 RPCs (mitigated by the shared
// recordCache/refundCache), large enough to give per-skill breakdowns
// useful signal across skills with uneven traffic, and at current
// volume (~5 paid txns/day) covers ~40 days of activity — well within
// the "reflects current operational performance" window.
const SERVICE_AGGREGATES_SAMPLE_LIMIT = 200;

// Cap the parallel buyer-name resolutions per request. Each miss costs one
// IdentityRegistry.tokenURI RPC plus an outbound JSON fetch (IPFS gateway or
// HTTPS), so an uncapped 200-row page would otherwise hit IPFS gateways with
// 200 concurrent connections. Eight is enough to overlap network latency
// without looking like a small DDoS.
const BUYER_NAME_FETCH_CONCURRENCY = 8;

/** Resolved identity tuple for a buyer agentId; any field may be null. */
interface BuyerIdentity {
  name: string | null;
  walletAddress: Hex | null;
  agentURI: string | null;
}

/**
 * Per-agentId cache for buyer identity (name + wallet + agentURI). Tries
 * the `buyer_identities` DB cache first (populated when a buyer registers
 * through this gateway), then falls back to on-chain resolution via
 * `IdentityRegistry.tokenURI` and `IdentityRegistry.getAgentWallet` — the
 * same dual path that registration uses. Long TTL (1h default) because
 * identities are stable per token; rotation is rare and rebroadcast
 * tolerates a TTL window of lag.
 *
 * Two behaviors worth flagging:
 *
 *   - Negative caching: any failure (RPC error, fetch failure, malformed
 *     JSON, missing `name`) caches the partial result for the same TTL.
 *     Without this, a broken IPFS pin would re-fetch on every request and
 *     degrade the whole activity feed to the slowest buyer.
 *   - Inflight dedupe: concurrent misses for the same agentId coalesce
 *     into one resolve call. The activity feed sees the same buyer
 *     multiple times in steady state (repeat purchases), and a cold
 *     cache + 50-row fan-out would otherwise spawn N parallel lookups
 *     for the same identity.
 *
 * Exposes both `get()` (full tuple, used by /public/v1/buyers/:agentId)
 * and `getName()` (string-only, used by activity-feed enrichment) so the
 * existing callers don't need to thread null-chains.
 */
class BuyerIdentityCache {
  private readonly entries = new Map<
    string,
    { value: BuyerIdentity | null; fetchedAt: number }
  >();
  private readonly inflight = new Map<string, Promise<BuyerIdentity | null>>();
  private readonly ttlMs: number;
  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly fetchOptions: FetchAgentCardOptions,
    ttlMs = 60 * 60 * 1000,
  ) {
    this.ttlMs = ttlMs;
  }

  async get(agentId: bigint): Promise<BuyerIdentity | null> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.resolve(agentId).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    const value = await pending;
    this.entries.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  async getName(agentId: bigint): Promise<string | null> {
    const identity = await this.get(agentId);
    return identity?.name ?? null;
  }

  private async resolve(agentId: bigint): Promise<BuyerIdentity | null> {
    // 1. DB cache: buyer_identities holds {name, wallet, agentURI} captured
    //    at registration time. For buyers registered through this gateway
    //    this hits before any RPC — the common case for the marketing
    //    surface, since most activity is driven by gateway-registered
    //    agents.
    try {
      const row = await this.queries.getBuyerIdentity(agentId);
      if (row) {
        return {
          name: row.resolvedName,
          walletAddress: row.walletAddress,
          agentURI: row.agentURI.length > 0 ? row.agentURI : null,
        };
      }
    } catch {
      // DB hiccup — fall through to on-chain. Don't poison the cache.
    }

    // 2. On-chain fallback for buyers who didn't register through this
    //    gateway (e2e test suites, third-party SDKs, direct contract
    //    interaction). Fetch URI and wallet in parallel — both reads
    //    target the same IdentityRegistry contract and are independent.
    let agentURI: string | null = null;
    let walletAddress: Hex | null = null;
    try {
      agentURI = await this.reader.getAgentURI(agentId);
      if (agentURI && agentURI.length === 0) agentURI = null;
    } catch {
      // Agent not registered, or RPC down — leave null and continue.
    }
    try {
      const wallet = await this.reader.getAgentWallet(agentId);
      if (wallet && wallet !== "0x0000000000000000000000000000000000000000") {
        walletAddress = wallet;
      }
    } catch {
      // Same: leave null and continue.
    }

    // Resolve a display name from the URI if possible, then fall back to
    // a wallet-derived default. Matches the name-only behavior buyers
    // see at registration time (see mcp/util.ts).
    let name: string | null = null;
    if (agentURI) {
      try {
        const card = await fetchAgentCard(agentURI, this.fetchOptions);
        if (card.name && card.name.length > 0) name = card.name;
      } catch {
        // Card fetch failed — fall through to wallet-derived name.
      }
    }
    if (!name && walletAddress) {
      name = `buyer-${walletAddress.toLowerCase().slice(-6)}`;
    }

    if (!name && !walletAddress && !agentURI) return null;
    return { name, walletAddress, agentURI };
  }
}

/** Per-agentId aggregate value: the full buyer-profile data block. */
interface BuyerProfileValue {
  reputation: PublicBuyerReputation;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  recentPurchases: ChainActivityRow[];
}

/**
 * Per-buyer profile cache: one fetch pass per buyer, combining the
 * SQL aggregate and the most-recent N rows. 60s TTL is the same shape
 * as ServiceAggregatesCache — aggregates move slowly (one new
 * transaction shifts each metric by ~1/N) so consumers can poll without
 * thrashing Postgres. Recent-purchases list is short (10 rows by
 * default) and cheap to refresh; bundling it with the aggregate
 * preserves the "one cache hit, one render" contract.
 *
 * Returns an empty-shaped value (counts all zero, recentPurchases [])
 * rather than null when the buyer has no settled rows — the route
 * still emits 200 with a real PublicBuyerDetail so the marketing site
 * doesn't have to special-case missing buyers. The 404 is reserved for
 * unparseable agentIds.
 */
class BuyerProfileCache {
  private readonly entries = new Map<
    string,
    { value: BuyerProfileValue; fetchedAt: number }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly queries: Queries,
    ttlMs = 60_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(agentId: bigint): Promise<BuyerProfileValue> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;

    try {
      const [agg, recent] = await Promise.all([
        this.queries.aggregateChainActivityByBuyer(agentId),
        this.queries.listRecentChainActivityByBuyer(
          agentId,
          PER_BUYER_RECENT_LIMIT,
        ),
      ]);
      const value: BuyerProfileValue = {
        reputation: derivePublicBuyerReputation(agg),
        firstPurchaseAt: agg.firstSettledAt,
        lastPurchaseAt: agg.lastSettledAt,
        recentPurchases: recent,
      };
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      // DB failure: serve previous value if any, else the documented
      // empty shape so the route still renders.
      return hit?.value ?? EMPTY_BUYER_PROFILE;
    }
  }
}

/**
 * Buyer leaderboard cache. The `GROUP BY buyer_agent_id` scan over
 * chain_events is cheap at current volume but grows with the table, so
 * a global 60s TTL cache amortizes it across all visitors. Keyed by
 * limit so distinct `?limit=` values cache independently — typical
 * marketing-site usage will only hit one or two limits, so cache size
 * stays bounded.
 */
class BuyerLeaderboardCache {
  private readonly entries = new Map<
    number,
    {
      value: Array<{
        agentId: bigint;
        transactionCount: number;
        totalSpentAtomic: bigint;
        lastSettledAt: Date;
        resolvedName: string | null;
      }>;
      fetchedAt: number;
    }
  >();
  private readonly ttlMs: number;
  constructor(
    private readonly queries: Queries,
    ttlMs = 60_000,
  ) {
    this.ttlMs = ttlMs;
  }
  async get(limit: number) {
    const now = Date.now();
    const hit = this.entries.get(limit);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const rows = await this.queries.listBuyersByVolume(limit);
      this.entries.set(limit, { value: rows, fetchedAt: now });
      return rows;
    } catch {
      return hit?.value ?? [];
    }
  }
}

const EMPTY_BUYER_PROFILE: BuyerProfileValue = {
  reputation: derivePublicBuyerReputation({
    transactionCount: 0,
    totalSpentAtomic: 0n,
    totalRefundedAtomic: 0n,
    refundCount: 0,
    completedCount: 0,
    failedCount: 0,
    canceledCount: 0,
    confirmedCount: 0,
    notConfirmedCount: 0,
    uniqueProviderCount: 0,
    uniqueSkillCount: 0,
    fulfillmentSumSeconds: 0,
    fulfillmentSampleSize: 0,
  }),
  firstPurchaseAt: null,
  lastPurchaseAt: null,
  recentPurchases: [],
};

/**
 * Concurrency-capped parallel map. Fans out at most `limit` workers over
 * `items`, preserving result order. Used to bound the outbound network
 * fan-out for per-row buyer-name resolution — without this, an N-row page
 * spawns N concurrent IPFS gateway fetches on a cold cache.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  return out;
}

// Fan out per-row record + refund lookups in parallel. Rows without a
// paymentId (legacy / mid-settlement rows) resolve to (null, 0n) without
// touching either cache — the formatter renders defaults for both.
async function loadEnrichmentFor(
  rows: readonly StoredChallenge[],
  recordCache: ReputationRecordCache,
  refundCache: RefundAmountCache,
): Promise<Array<{ record: ReputationRecord | null; refundedAtomic: bigint }>> {
  return Promise.all(
    rows.map(async (c) => {
      if (c.paymentId == null) {
        return { record: null, refundedAtomic: 0n };
      }
      // Parallel by design: the two reads hit different contracts so a
      // multicall wouldn't help, and the caches are independent.
      const [record, refundedAtomic] = await Promise.all([
        recordCache.get(c.paymentId),
        refundCache.get(c.paymentId),
      ]);
      return { record, refundedAtomic };
    }),
  );
}

function parseLimit(raw: unknown, fallback: number, cap: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), cap);
}

function notFound(res: Response, message: string) {
  res.status(404).json({
    error: { code: "SERVICE_NOT_FOUND", message },
  });
}

export interface PublicRouterDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  /**
   * Test seam for the agentURI fetcher used to resolve buyer display names.
   * Production leaves this undefined so `fetchAgentCard` uses its default
   * `safeFetch`; tests pass a stub that returns canned JSON without going
   * to the network. (data: URIs bypass this entirely.)
   */
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
  /** Override the block-number TTL (ms). Tests pass 0 to bypass caching. */
  blockNumberCacheTtlMs?: number;
  /** Override the provider-reputation TTL (ms). Tests pass 0 to bypass caching. */
  reputationCacheTtlMs?: number;
  /** Override the per-paymentId record TTL (ms). Tests pass 0 to bypass caching. */
  reputationRecordCacheTtlMs?: number;
  /** Override the per-paymentId refund TTL (ms). Tests pass 0 to bypass caching. */
  refundAmountCacheTtlMs?: number;
  /** Override the per-service aggregates TTL (ms). Tests pass 0 to bypass caching. */
  serviceAggregatesCacheTtlMs?: number;
  /** Override the per-buyer name TTL (ms). Tests pass 0 to bypass caching. */
  buyerNameCacheTtlMs?: number;
  /** Override the per-buyer profile TTL (ms). Tests pass 0 to bypass caching. */
  buyerProfileCacheTtlMs?: number;
  /** Override the buyer leaderboard TTL (ms). Tests pass 0 to bypass caching. */
  buyerLeaderboardCacheTtlMs?: number;
}

/**
 * Read-only API consumed by the marketing/explorer site at sandbox.daski.io.
 * Unlike `/discover` (which returns raw Agent Cards for buyer agents), these
 * routes return curated, UI-friendly shapes with human-readable USDC prices
 * and provider name joins. Stable contract: response shapes are intended to
 * survive a future swap from DB-as-source to a `PaymentSettled` event indexer.
 */
export function createPublicRouter(deps: PublicRouterDeps): Router {
  const { config, cache, queries, reader } = deps;
  const router = Router();
  const blockCache = new BlockNumberCache(
    reader,
    deps.blockNumberCacheTtlMs ?? 2000,
  );
  const reputationCache = new ProviderReputationCache(
    reader,
    queries,
    SERVICE_AGGREGATES_SAMPLE_LIMIT,
    deps.reputationCacheTtlMs ?? 30_000,
  );
  const serviceReputationCache = new ServiceReputationCache(
    reader,
    queries,
    deps.reputationCacheTtlMs ?? 30_000,
  );
  const recordCache = new ReputationRecordCache(
    reader,
    deps.reputationRecordCacheTtlMs ?? 60_000,
  );
  const refundCache = new RefundAmountCache(
    reader,
    deps.refundAmountCacheTtlMs ?? 30_000,
  );
  const serviceAggregatesCache = new ServiceAggregatesCache(
    queries,
    SERVICE_AGGREGATES_SAMPLE_LIMIT,
    deps.serviceAggregatesCacheTtlMs ?? 60_000,
  );
  const buyerIdentityCache = new BuyerIdentityCache(
    reader,
    queries,
    {
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      fetchFn: deps.buyerAgentCardFetch,
    },
    deps.buyerNameCacheTtlMs ?? 60 * 60 * 1000,
  );
  const buyerProfileCache = new BuyerProfileCache(
    queries,
    deps.buyerProfileCacheTtlMs ?? 60_000,
  );
  const buyerLeaderboardCache = new BuyerLeaderboardCache(
    queries,
    deps.buyerLeaderboardCacheTtlMs ?? 60_000,
  );

  router.get("/public/v1/services", (_req: Request, res: Response) => {
    const services: PublicService[] = [];
    for (const provider of cache.getAll()) {
      const formatted = formatServiceForPublic(provider);
      if (formatted) services.push(formatted);
    }
    res.json({
      services,
      cachedAt: cache.getLastRefresh()?.toISOString() ?? null,
    });
  });

  router.get(
    "/public/v1/services/:agentId",
    async (req: Request, res: Response) => {
      let agentId: bigint;
      try {
        agentId = BigInt(String(req.params.agentId));
      } catch {
        notFound(res, "unknown service");
        return;
      }
      const provider = cache.get(agentId);
      if (!provider) {
        notFound(res, "unknown service");
        return;
      }
      const formatted = formatServiceForPublic(provider);
      if (!formatted) {
        notFound(res, "unknown service");
        return;
      }
      const [recent, reputation, serviceReputation, serviceAggregates] =
        await Promise.all([
          // recentPurchases now sources from chain_events too — same data
          // model as /activity, just filtered by provider. Chain-only rows
          // (settled outside this gateway) surface here as well.
          queries.listRecentChainActivityByProvider(
            agentId,
            PER_SERVICE_RECENT_LIMIT,
          ),
          reputationCache.get(agentId),
          // Scope-narrow service-level counters. Reads only when the cached
          // provider resolves to a primary serviceId — otherwise the UI sees
          // null and renders the same empty state it uses for unconfigured
          // ReputationStorage.
          formatted.serviceId
            ? serviceReputationCache.get(formatted.serviceId)
            : Promise.resolve(null),
          // Off-chain per-service aggregates: fulfillment mean,
          // USDC-value-weighted satisfaction, and per-skill breakdown. All
          // three derive from the same chain_events sample so one cache
          // entry covers them. Skipped when no serviceId — the merge below
          // leaves serviceReputation untouched and skillStats is [].
          formatted.serviceId
            ? serviceAggregatesCache.get(formatted.serviceId)
            : Promise.resolve(null),
        ]);
      const buyerNames = await mapWithLimit(
        recent,
        BUYER_NAME_FETCH_CONCURRENCY,
        (r) => buyerIdentityCache.getName(r.buyerAgentId),
      );
      const recentPurchases = recent.map((r, i) =>
        formatChainActivityRow(
          r,
          formatted.name,
          buyerNames[i] ?? null,
        ),
      );
      // Merge the off-chain aggregates into the chain-derived service
      // reputation. The two caches have independent TTLs (60s for the
      // aggregate, 30s for the raw counters) so we don't recompute the
      // mean every time a new transaction shifts a counter.
      const mergedServiceReputation =
        serviceReputation && serviceAggregates
          ? {
              ...serviceReputation,
              averageFulfillmentSeconds:
                serviceAggregates.fulfillment.averageFulfillmentSeconds,
              fulfillmentSampleSize: serviceAggregates.fulfillment.sampleSize,
              buyerSatisfactionRateByValue:
                serviceAggregates.weightedSatisfaction.rateByValue,
              buyerSatisfactionRateByValueSampleSize:
                serviceAggregates.weightedSatisfaction.sampleSize,
            }
          : serviceReputation;
      // Fill skillName from the formatted service's catalog. We could
      // also resolve via cache.get(agentId) but `formatted.skills` is
      // already a cleaned representation; one pass through it gets us
      // the names without another extraction.
      const skillNameById = new Map<string, string>();
      for (const s of formatted.skills) {
        if (s.name && s.name.length > 0) skillNameById.set(s.id, s.name);
      }
      const skillStats = (serviceAggregates?.skillStats ?? []).map((s) => ({
        ...s,
        skillName: skillNameById.get(s.skillId) ?? null,
      }));
      res.json({
        ...formatted,
        recentPurchases,
        reputation,
        serviceReputation: mergedServiceReputation,
        skillStats,
      });
    },
  );

  router.get("/public/v1/activity", async (req: Request, res: Response) => {
    const limit = parseLimit(
      req.query.limit,
      ACTIVITY_DEFAULT_LIMIT,
      ACTIVITY_MAX_LIMIT,
    );
    // Source rows from chain_events (the indexer's mirror of on-chain
    // PaymentSettled + per-paymentId outcome/confirmation/refund) with
    // a LEFT JOIN onto payment_challenges for off-chain enrichment
    // (skillId, original a2a URL, walletAddress). Chain-only rows surface
    // with skillId null — the UI renders `-` in that case.
    const rows = await queries.listRecentChainActivity(limit);

    const nameByAgentId = new Map<string, string>();
    for (const provider of cache.getAll()) {
      nameByAgentId.set(
        provider.agentId.toString(),
        extractAgentCardName(provider.agentCard),
      );
    }

    const buyerNames = await mapWithLimit(
      rows,
      BUYER_NAME_FETCH_CONCURRENCY,
      (r) => buyerIdentityCache.getName(r.buyerAgentId),
    );
    res.json({
      activity: rows.map((r, i) =>
        formatChainActivityRow(
          r,
          nameByAgentId.get(r.providerAgentId.toString()) ?? null,
          buyerNames[i] ?? null,
        ),
      ),
    });
  });

  router.get("/public/v1/stats", async (_req: Request, res: Response) => {
    const blockNumber = await blockCache.get();
    const agg = await queries.getPaidAggregate();
    res.json({
      chain: {
        chainId: config.chainId,
        network: config.network,
        blockNumber: blockNumber.toString(),
      },
      marketplace: {
        providerCount: cache.getAll().length,
        paidCount: agg.count,
        totalVolumeUsdc: (Number(agg.totalAtomic) / 1_000_000).toFixed(2),
      },
      contracts: {
        paymentRouter: config.paymentRouterAddress,
        providerRegistry: config.providerRegistryAddress,
        serviceRegistry: config.serviceRegistryAddress,
        identityRegistry: config.identityRegistryAddress,
        x402Adapter: config.x402AdapterAddress,
        permitAdapter: config.permitAdapterAddress ?? null,
        approvalAdapter: config.approvalAdapterAddress ?? null,
        reputationStorage: config.reputationStorageAddress ?? null,
        usdc: config.usdcAddress,
      },
    });
  });

  // ── /public/v1/buyers ─────────────────────────────────────────────────
  //
  // Marketplace-side stats keyed by buyer agentId. The detail endpoint
  // is the buyer mirror of /public/v1/services/:agentId — it always
  // returns 200 (with zero-valued counters) for any parseable agentId,
  // so the marketing site can deep-link to any buyer without a
  // 404-handling branch. The list endpoint is a lifetime-spend
  // leaderboard. All data is sourced from chain_events; no RPCs at
  // request time.

  router.get("/public/v1/buyers", async (req: Request, res: Response) => {
    const limit = parseLimit(
      req.query.limit,
      BUYER_LEADERBOARD_DEFAULT_LIMIT,
      BUYER_LEADERBOARD_MAX_LIMIT,
    );
    const rows = await buyerLeaderboardCache.get(limit);
    // Fill missing names by falling back to the BuyerIdentityCache, which
    // does the on-chain wallet → `buyer-<last6>` derivation for buyers
    // who don't have a buyer_identities row. Bounded fan-out for the
    // same reason as the activity feed: a cold cache on a 100-row page
    // would otherwise spawn 100 concurrent IdentityRegistry reads.
    const fallbackNames = await mapWithLimit(
      rows,
      BUYER_NAME_FETCH_CONCURRENCY,
      (r) => (r.resolvedName ? Promise.resolve(r.resolvedName) : buyerIdentityCache.getName(r.agentId)),
    );
    const buyers: PublicBuyerSummary[] = rows.map((r, i) => ({
      agentId: r.agentId.toString(),
      name: fallbackNames[i] ?? null,
      totalSpentUsdc: (Number(r.totalSpentAtomic) / 1_000_000).toFixed(2),
      transactionCount: r.transactionCount,
      lastPurchaseAt: r.lastSettledAt.toISOString(),
    }));
    res.json({ buyers });
  });

  router.get(
    "/public/v1/buyers/:agentId",
    async (req: Request, res: Response) => {
      let agentId: bigint;
      try {
        agentId = BigInt(String(req.params.agentId));
      } catch {
        res.status(404).json({
          error: { code: "BUYER_NOT_FOUND", message: "unknown buyer" },
        });
        return;
      }
      const [profile, identity] = await Promise.all([
        buyerProfileCache.get(agentId),
        buyerIdentityCache.get(agentId),
      ]);
      const recentPurchases = profile.recentPurchases.map((r) =>
        formatChainActivityRow(
          r,
          // Provider name: pull from the discovery cache if we know the
          // provider. Falls back to null (same contract as /activity).
          (() => {
            const provider = cache.get(r.providerAgentId);
            return provider
              ? extractAgentCardName(provider.agentCard)
              : null;
          })(),
          identity?.name ?? null,
        ),
      );
      const detail: PublicBuyerDetail = {
        agentId: agentId.toString(),
        walletAddress: identity?.walletAddress ?? null,
        name: identity?.name ?? null,
        agentURI: identity?.agentURI ?? null,
        firstPurchaseAt: profile.firstPurchaseAt?.toISOString() ?? null,
        lastPurchaseAt: profile.lastPurchaseAt?.toISOString() ?? null,
        reputation: profile.reputation,
        recentPurchases,
      };
      res.json(detail);
    },
  );

  return router;
}
