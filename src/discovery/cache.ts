import {
  fetchOnChainProviders,
  type ProviderAuthoritySnapshot,
  type ProviderDiscoveryReader,
} from "../chain/reader.js";
import { ProviderLegalValidationError } from "../legal/validation.js";
import type { CachedProvider } from "../types.js";
import { logger as defaultLogger, type GatewayLogger } from "../util/logger.js";
import {
  AgentCardFetcher,
  type AgentCardFetchFn,
} from "./agentCardFetcher.js";
import { catalogChanged } from "./catalogSnapshot.js";
import { ProviderCardResolver } from "./providerCardResolver.js";
import { DiscoveryRefreshScheduler } from "./refreshScheduler.js";

const DEFAULT_MAX_CARD_STALENESS_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_A2A_ENTRIES = 16;
const DEFAULT_FETCH_CONCURRENCY = 4;
const DEFAULT_REFRESH_DEADLINE_MS = 30_000;

export type FetchFn = AgentCardFetchFn;

interface CacheOptions {
  reader: ProviderDiscoveryReader;
  whitelist: bigint[];
  refreshIntervalSeconds: number;
  maxCardStalenessSeconds?: number;
  fetch?: FetchFn;
  agentCardFetchTimeoutMs?: number;
  maxA2AEntries?: number;
  fetchConcurrency?: number;
  refreshDeadlineMs?: number;
  onCatalogChanged?: (oldProviders: CachedProvider[], newProviders: CachedProvider[]) => void;
  logger?: Pick<GatewayLogger, "log" | "warn" | "error">;
}

export class DiscoveryCache {
  private cache = new Map<string, CachedProvider>();
  private lastRefresh: Date | null = null;
  private lastCycleAt: Date | null = null;
  private lastChainSuccessAt: Date | null = null;
  private lastChainError: { message: string; at: Date } | null = null;
  private cardFailureCount = 0;
  private catalogInitialized = false;
  private readonly reader: ProviderDiscoveryReader;
  private readonly whitelist: bigint[];
  private readonly refreshIntervalMs: number;
  private readonly maxCardStalenessMs: number;
  private readonly refreshDeadlineMs: number;
  private readonly resolver: ProviderCardResolver;
  private readonly scheduler: DiscoveryRefreshScheduler;
  private readonly onCatalogChanged?: CacheOptions["onCatalogChanged"];
  private readonly logger: Pick<GatewayLogger, "log" | "warn" | "error">;

  constructor(opts: CacheOptions) {
    this.reader = opts.reader;
    this.whitelist = opts.whitelist;
    this.refreshIntervalMs = opts.refreshIntervalSeconds * 1000;
    this.maxCardStalenessMs =
      (opts.maxCardStalenessSeconds ?? DEFAULT_MAX_CARD_STALENESS_SECONDS) * 1000;
    this.refreshDeadlineMs = opts.refreshDeadlineMs ?? DEFAULT_REFRESH_DEADLINE_MS;
    if (!Number.isSafeInteger(this.refreshDeadlineMs) || this.refreshDeadlineMs <= 0) {
      throw new Error("discovery refresh deadline must be a positive integer");
    }
    this.onCatalogChanged = opts.onCatalogChanged;
    this.logger = opts.logger ?? defaultLogger;
    const fetcher = new AgentCardFetcher({
      fetch: opts.fetch,
      timeoutMs: opts.agentCardFetchTimeoutMs,
    });
    this.resolver = new ProviderCardResolver({
      fetcher,
      maxA2AEntries: opts.maxA2AEntries ?? DEFAULT_MAX_A2A_ENTRIES,
      fetchConcurrency: opts.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY,
      logger: this.logger,
    });
    this.scheduler = new DiscoveryRefreshScheduler({
      refreshIntervalMs: this.refreshIntervalMs,
      refresh: () => this.refresh(),
      awaitingFirstCard: () => this.hasProviderAwaitingFirstCard(),
      logger: this.logger,
    });
  }

  getAll(): CachedProvider[] {
    return [...this.cache.values()].sort((a, b) =>
      a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
    );
  }

  get(agentId: bigint): CachedProvider | undefined {
    return this.cache.get(agentId.toString());
  }

  getForDiscovery(agentId: bigint): CachedProvider | undefined {
    return this.get(agentId);
  }

  authorityIsFresh(provider: CachedProvider, maxAgeMs: number): boolean {
    return (
      provider.authorityActive &&
      Date.now() - provider.authorityObservedAt.getTime() <= maxAgeMs
    );
  }

  getLastRefresh(): Date | null {
    return this.lastRefresh;
  }

  status() {
    const freshForMs = Math.max(this.refreshIntervalMs * 3, 120_000);
    return {
      lastCycleAt: this.lastCycleAt,
      lastChainSuccessAt: this.lastChainSuccessAt,
      lastChainError: this.lastChainError,
      cardFailureCount: this.cardFailureCount,
      chainFresh:
        this.lastChainSuccessAt !== null &&
        Date.now() - this.lastChainSuccessAt.getTime() <= freshForMs,
    };
  }

  async refresh(): Promise<void> {
    const deadlineAt = Date.now() + this.refreshDeadlineMs;
    const oldSnapshot = this.getAll();
    let onChain;
    try {
      onChain = await withDeadline(
        fetchOnChainProviders(this.reader, this.whitelist),
        deadlineAt,
        "provider registry discovery timed out",
      );
    } catch (error) {
      const message = (error as Error).message;
      const wasHealthy = this.lastChainError === null;
      this.lastCycleAt = new Date();
      this.lastChainError = { message, at: this.lastCycleAt };
      if (wasHealthy) {
        this.logger.error("[cache] provider registry became unavailable", {
          error,
        });
      }
      return;
    }
    if (this.lastChainError) this.logger.log("[cache] provider registry recovered");
    this.lastChainSuccessAt = new Date();
    const authorityObservedAt = this.lastChainSuccessAt;
    this.lastChainError = null;

    const nextCache = new Map<string, CachedProvider>();
    let cardFailureCount = 0;
    for (const provider of onChain) {
      const existing = this.cache.get(provider.agentId.toString());
      try {
        const resolved = await this.resolver.resolve(provider.agentURI, deadlineAt);
        const { partialError, ...providerCards } = resolved;
        nextCache.set(provider.agentId.toString(), {
          agentId: provider.agentId,
          walletAddress: provider.walletAddress,
          agentURI: provider.agentURI,
          authorityObservedAt,
          authorityObservedBlock: provider.observedBlock,
          authorityActive: provider.isActive,
          ...providerCards,
          lastFetched: new Date(),
          fetchError: partialError,
        });
      } catch (error) {
        cardFailureCount += 1;
        const message = (error as Error).message ?? String(error);
        const hardLegalFailure = error instanceof ProviderLegalValidationError;
        this.logger.warn("[cache] failed to fetch agent card", {
          agentId: provider.agentId,
          agentUri: provider.agentURI,
          error,
        });
        const hasKnownGoodCard = existing !== undefined && existing.cards.length > 0;
        const agentURIChanged =
          existing !== undefined && existing.agentURI !== provider.agentURI;
        const withinStalenessCap =
          existing !== undefined &&
          Date.now() - existing.lastFetched.getTime() <= this.maxCardStalenessMs;
        if (
          !hardLegalFailure &&
          !agentURIChanged &&
          existing &&
          hasKnownGoodCard &&
          withinStalenessCap
        ) {
          nextCache.set(provider.agentId.toString(), {
            ...existing,
            walletAddress: provider.walletAddress,
            agentURI: provider.agentURI,
            authorityObservedAt,
            authorityObservedBlock: provider.observedBlock,
            authorityActive: provider.isActive,
            fetchError: message,
          });
        } else {
          if (hasKnownGoodCard) {
            const reason = hardLegalFailure
              ? "provider legal metadata is invalid"
              : agentURIChanged
                ? "on-chain agentURI changed"
                : `staleness cap ${this.maxCardStalenessMs / 1000}s exceeded`;
            this.logger.warn(
              `[cache] dropping agent ${provider.agentId}'s last-known-good card: ${reason}`,
            );
          }
          nextCache.set(provider.agentId.toString(), {
            agentId: provider.agentId,
            walletAddress: provider.walletAddress,
            agentURI: provider.agentURI,
            authorityObservedAt,
            authorityObservedBlock: provider.observedBlock,
            authorityActive: provider.isActive,
            cards: [],
            providerName: null,
            providerDescription: null,
            providerImage: null,
            providerExternalUrl: null,
            providerLegal: null,
            lastFetched: new Date(),
            fetchError: message,
          });
        }
      }
    }

    this.cache = nextCache;
    this.cardFailureCount = cardFailureCount;
    this.lastCycleAt = new Date();
    this.lastRefresh = this.lastCycleAt;
    const newSnapshot = this.getAll();
    if (
      this.onCatalogChanged &&
      (!this.catalogInitialized || catalogChanged(oldSnapshot, newSnapshot))
    ) {
      try {
        this.onCatalogChanged(oldSnapshot, newSnapshot);
      } catch (error) {
        this.logger.error("[cache] onCatalogChanged callback threw", {
          error,
        });
      }
    }
    this.catalogInitialized = true;
  }

  async refreshProviderAuthority(
    agentId: bigint,
  ): Promise<{
    provider: CachedProvider;
    authority: ProviderAuthoritySnapshot;
  }> {
    if (
      this.whitelist.length > 0 &&
      !this.whitelist.some((allowed) => allowed === agentId)
    ) {
      throw new Error("provider is not admitted");
    }
    const blockNumber = await this.reader.getBlockNumber();
    const authority = await this.reader.getProviderAuthority(
      agentId,
      blockNumber,
    );
    if (!authority.isActive) throw new Error("provider is inactive");
    const existing = this.cache.get(agentId.toString());
    let provider: CachedProvider;
    if (
      existing &&
      existing.agentURI === authority.agentURI &&
      existing.cards.length > 0
    ) {
      provider = {
        ...existing,
        walletAddress: authority.walletAddress,
        authorityObservedAt: new Date(),
        authorityObservedBlock: authority.observedBlock,
        authorityActive: true,
      };
    } else {
      const resolved = await this.resolver.resolve(
        authority.agentURI,
        Date.now() + this.refreshDeadlineMs,
      );
      const { partialError, ...cards } = resolved;
      provider = {
        agentId,
        walletAddress: authority.walletAddress,
        agentURI: authority.agentURI,
        ...cards,
        lastFetched: new Date(),
        fetchError: partialError,
        authorityObservedAt: new Date(),
        authorityObservedBlock: authority.observedBlock,
        authorityActive: true,
      };
    }
    this.cache.set(agentId.toString(), provider);
    return { provider, authority };
  }

  start(): void {
    this.scheduler.start();
  }

  stopAndDrain(): Promise<void> {
    return this.scheduler.stopAndDrain();
  }

  private hasProviderAwaitingFirstCard(): boolean {
    return (
      this.lastRefresh === null ||
      [...this.cache.values()].some((provider) => provider.cards.length === 0)
    );
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  message: string,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(message);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
