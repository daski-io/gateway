import { Router, type Request, type Response } from "express";
import type { ChainReader, ReputationRecord } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { extractAgentCardName } from "../discovery/format.js";
import {
  deriveProviderReputation,
  deriveServiceReputation,
  formatActivityRow,
  formatServiceForPublic,
  type PublicService,
  type PublicServiceLevelReputation,
  type PublicServiceReputation,
} from "./format.js";
import type { Hex, StoredChallenge } from "../types.js";

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;
const PER_SERVICE_RECENT_LIMIT = 10;

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
      const raw = await this.reader.getProviderReputation(agentId);
      const value = raw ? deriveProviderReputation(raw) : null;
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
      const raw = await this.reader.getServiceReputation(serviceId);
      const value = raw ? deriveServiceReputation(raw, serviceId) : null;
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
  /** Override the block-number TTL (ms). Tests pass 0 to bypass caching. */
  blockNumberCacheTtlMs?: number;
  /** Override the provider-reputation TTL (ms). Tests pass 0 to bypass caching. */
  reputationCacheTtlMs?: number;
  /** Override the per-paymentId record TTL (ms). Tests pass 0 to bypass caching. */
  reputationRecordCacheTtlMs?: number;
  /** Override the per-paymentId refund TTL (ms). Tests pass 0 to bypass caching. */
  refundAmountCacheTtlMs?: number;
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
    deps.reputationCacheTtlMs ?? 30_000,
  );
  const serviceReputationCache = new ServiceReputationCache(
    reader,
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
      const [recent, reputation, serviceReputation] = await Promise.all([
        queries.listRecentPaidByProvider(agentId, PER_SERVICE_RECENT_LIMIT),
        reputationCache.get(agentId),
        // Scope-narrow service-level counters. Reads only when the cached
        // provider resolves to a primary serviceId — otherwise the UI sees
        // null and renders the same empty state it uses for unconfigured
        // ReputationStorage.
        formatted.serviceId
          ? serviceReputationCache.get(formatted.serviceId)
          : Promise.resolve(null),
      ]);
      const enrichment = await loadEnrichmentFor(recent, recordCache, refundCache);
      const recentPurchases = recent.map((c, i) =>
        formatActivityRow(
          c,
          formatted.name,
          enrichment[i]?.record ?? null,
          enrichment[i]?.refundedAtomic ?? 0n,
        ),
      );
      res.json({
        ...formatted,
        recentPurchases,
        reputation,
        serviceReputation,
      });
    },
  );

  router.get("/public/v1/activity", async (req: Request, res: Response) => {
    const limit = parseLimit(
      req.query.limit,
      ACTIVITY_DEFAULT_LIMIT,
      ACTIVITY_MAX_LIMIT,
    );
    const rows = await queries.listRecentPaid(limit);

    // One pass over the cache to build a name lookup, then per-row O(1).
    const nameByAgentId = new Map<string, string>();
    for (const provider of cache.getAll()) {
      nameByAgentId.set(
        provider.agentId.toString(),
        extractAgentCardName(provider.agentCard),
      );
    }

    const enrichment = await loadEnrichmentFor(rows, recordCache, refundCache);
    res.json({
      activity: rows.map((c, i) =>
        formatActivityRow(
          c,
          nameByAgentId.get(c.providerTokenId.toString()) ?? null,
          enrichment[i]?.record ?? null,
          enrichment[i]?.refundedAtomic ?? 0n,
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

  return router;
}
