import type { ProviderAuthoritySnapshot } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";

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
  private readonly pending = new Map<
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
      return {
        agentId: cached.agentId,
        isActive: cached.authorityActive,
        walletAddress: cached.walletAddress,
        agentURI: cached.agentURI,
        registrationTime: 0n,
        observedBlock: cached.authorityObservedBlock,
      };
    }
    const key = agentId.toString();
    const existing = this.pending.get(key);
    if (existing) return existing;
    const refresh = this.refresh(agentId);
    this.pending.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (this.pending.get(key) === refresh) this.pending.delete(key);
    }
  }

  private async refresh(
    agentId: bigint,
  ): Promise<ProviderAuthoritySnapshot> {
    try {
      const { authority } =
        await this.cache.refreshProviderAuthority(agentId);
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
