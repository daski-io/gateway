import type { ChainReader } from "../../chain/reader.js";
import type { Queries } from "../../db/queries.js";
import { fetchAgentCard, type FetchAgentCardOptions } from "../../identity/fetch-agent-card.js";
import { sanitizeBuyerName } from "../../identity/name.js";
import type { Hex } from "../../types.js";

export interface BuyerIdentity {
  name: string | null;
  walletAddress: Hex | null;
  agentURI: string | null;
}

export class BuyerIdentityCache {
  private readonly entries = new Map<string, { value: BuyerIdentity | null; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<BuyerIdentity | null>>();

  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly fetchOptions: FetchAgentCardOptions,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  async get(agentId: bigint): Promise<BuyerIdentity | null> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.resolve(agentId).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await pending;
    this.entries.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  async getName(agentId: bigint): Promise<string | null> {
    return (await this.get(agentId))?.name ?? null;
  }

  private async resolve(agentId: bigint): Promise<BuyerIdentity | null> {
    try {
      const stored = await this.queries.getBuyerIdentity(agentId);
      if (stored) {
        const storedName = sanitizeBuyerName(stored.resolvedName);
        return {
          name: storedName.ok ? storedName.name : null,
          walletAddress: stored.walletAddress,
          agentURI: stored.agentURI || null,
        };
      }
    } catch {
      // Fall through to the canonical on-chain identity.
    }

    const [agentURI, walletAddress] = await Promise.all([
      this.reader.getAgentURI(agentId).catch(() => null),
      this.reader.getAgentWallet(agentId).catch(() => null),
    ]);
    const usableWallet =
      walletAddress && walletAddress !== "0x0000000000000000000000000000000000000000"
        ? walletAddress
        : null;
    let name: string | null = null;
    if (agentURI) {
      try {
        const fetched = await fetchAgentCard(agentURI, this.fetchOptions);
        const fetchedName = sanitizeBuyerName(fetched.name);
        name = fetchedName.ok ? fetchedName.name : null;
      } catch {
        // Wallet-derived names keep the public API usable if metadata fails.
      }
    }
    if (!name && usableWallet) {
      name = `buyer-${usableWallet.toLowerCase().slice(-6)}`;
    }
    if (!name && !usableWallet && !agentURI) return null;
    return {
      name,
      walletAddress: usableWallet,
      agentURI: agentURI || null,
    };
  }
}
