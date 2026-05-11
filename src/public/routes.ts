import { Router, type Request, type Response } from "express";
import type { ChainReader } from "../chain/reader.js";
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
import type { Hex } from "../types.js";

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
      const recentPurchases = recent.map((c) =>
        formatActivityRow(c, formatted.name),
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

    res.json({
      activity: rows.map((c) =>
        formatActivityRow(
          c,
          nameByAgentId.get(c.providerTokenId.toString()) ?? null,
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
