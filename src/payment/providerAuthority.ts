import type { ProviderAuthoritySnapshot } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { CachedProvider } from "../types.js";

export type ProviderAuthorityFailure =
  | "provider_authority_unavailable"
  | "provider_inactive";

export class ProviderAuthorityError extends Error {
  constructor(readonly code: ProviderAuthorityFailure) {
    super(code);
    this.name = "ProviderAuthorityError";
  }
}

export class ProviderAuthorityService {
  private readonly pendingAuthority = new Map<
    string,
    Promise<ProviderAuthoritySnapshot>
  >();
  private readonly pendingCatalog = new Map<
    string,
    Promise<ProviderAuthoritySnapshot>
  >();
  private readonly maxAgeMs: number;

  constructor(
    private readonly cache: DiscoveryCache,
    config: Config,
  ) {
    this.maxAgeMs = config.providerAuthMaxAgeSeconds * 1_000;
  }

  async requireFresh(agentId: bigint): Promise<ProviderAuthoritySnapshot> {
    const cached = this.cache.getForDiscovery(agentId);
    if (cached && this.cache.authorityIsFresh(cached, this.maxAgeMs)) {
      return authorityFromCache(cached);
    }
    return this.refreshOnce(agentId, false);
  }

  /** Requires recent on-chain authority and a successfully resolved catalog. */
  async requireFreshCatalog(
    agentId: bigint,
  ): Promise<ProviderAuthoritySnapshot> {
    const cached = this.cache.getForDiscovery(agentId);
    if (
      cached &&
      this.cache.authorityIsFresh(cached, this.maxAgeMs) &&
      cached.fetchError === null &&
      cached.cards.length > 0 &&
      Date.now() - cached.lastFetched.getTime() <= this.maxAgeMs
    ) {
      return authorityFromCache(cached);
    }
    return this.refreshOnce(agentId, true);
  }

  private async refreshOnce(
    agentId: bigint,
    refreshCatalog: boolean,
  ): Promise<ProviderAuthoritySnapshot> {
    const key = agentId.toString();
    const pending = refreshCatalog
      ? this.pendingCatalog
      : this.pendingAuthority;
    const existing = pending.get(key);
    if (existing) return existing;
    const refresh = this.refresh(agentId, refreshCatalog);
    pending.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (pending.get(key) === refresh) pending.delete(key);
    }
  }

  private async refresh(
    agentId: bigint,
    refreshCatalog: boolean,
  ): Promise<ProviderAuthoritySnapshot> {
    try {
      const { authority } = await this.cache.refreshProviderAuthority(agentId, {
        refreshCatalog,
      });
      if (!authority.isActive) {
        throw new ProviderAuthorityError("provider_inactive");
      }
      return authority;
    } catch (error) {
      if (error instanceof ProviderAuthorityError) throw error;
      if (
        error instanceof Error &&
        /inactive|not admitted/i.test(error.message)
      ) {
        throw new ProviderAuthorityError("provider_inactive");
      }
      throw new ProviderAuthorityError("provider_authority_unavailable");
    }
  }
}

function authorityFromCache(
  provider: CachedProvider,
): ProviderAuthoritySnapshot {
  return {
    agentId: provider.agentId,
    isActive: provider.authorityActive,
    walletAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    registrationTime: 0n,
    observedBlock: provider.authorityObservedBlock,
  };
}
