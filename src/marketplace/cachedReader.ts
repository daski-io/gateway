import type { Address, Hex } from "viem";
import type {
  MarketplaceChainReader,
  MarketplaceServiceRecord,
} from "./reader.js";

// Registry state only changes on releases; a short shared cache keeps the public
// registry endpoints from re-reading finalized chain state on every request.
const CACHE_MILLISECONDS = 60_000;
const MAXIMUM_ENTRIES = 256;

interface CacheEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

export class CachedMarketplaceChainReader implements MarketplaceChainReader {
  readonly addresses;
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly source: MarketplaceChainReader) {
    this.addresses = source.addresses;
  }

  resolveWallet(wallet: Address): Promise<{ agentId: string; found: boolean }> {
    return this.cached(`wallet:${wallet.toLowerCase()}`, () => this.source.resolveWallet(wallet));
  }

  listProviders(offset: number, limit: number): Promise<unknown> {
    return this.cached(`providers:${offset}:${limit}`, () => this.source.listProviders(offset, limit));
  }

  getProvider(agentId: bigint): Promise<unknown> {
    return this.cached(`provider:${agentId}`, () => this.source.getProvider(agentId));
  }

  getService(serviceId: Hex): Promise<MarketplaceServiceRecord> {
    return this.cached(`service:${serviceId.toLowerCase()}`, () => this.source.getService(serviceId));
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.value as Promise<T>;
    this.entries.delete(key);
    if (this.entries.size >= MAXIMUM_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const value = load();
    this.entries.set(key, { expiresAt: Date.now() + CACHE_MILLISECONDS, value });
    value.catch(() => {
      const current = this.entries.get(key);
      if (current?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
