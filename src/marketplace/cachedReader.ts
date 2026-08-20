import type { Address, Hex } from "viem";
import type {
  MarketplaceChainReader,
  MarketplaceServiceRecord,
} from "./reader.js";

// Registry state only changes on releases; a short shared cache keeps the public
// registry endpoints from re-reading finalized chain state on every request, and
// the last good value stays servable through transient RPC failures instead of
// surfacing them to buyers.
const CACHE_MILLISECONDS = 60_000;
const STALE_LIMIT_MILLISECONDS = 24 * 60 * 60_000;
const MAXIMUM_ENTRIES = 256;

interface CacheEntry {
  freshUntil: number;
  staleUntil: number;
  value: unknown;
}

export class CachedMarketplaceChainReader implements MarketplaceChainReader {
  readonly addresses;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

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
    const entry = this.entries.get(key);
    const now = Date.now();
    if (entry && entry.freshUntil > now) return Promise.resolve(entry.value as T);
    const loading = this.startLoad(key, load);
    if (entry && entry.staleUntil > now) {
      loading.catch(() => undefined);
      return Promise.resolve(entry.value as T);
    }
    return loading;
  }

  private startLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(key);
    if (active) return active as Promise<T>;
    const loading = load()
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, loading);
    return loading;
  }

  private store(key: string, value: unknown): void {
    this.entries.delete(key);
    if (this.entries.size >= MAXIMUM_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const now = Date.now();
    this.entries.set(key, {
      freshUntil: now + CACHE_MILLISECONDS,
      staleUntil: now + STALE_LIMIT_MILLISECONDS,
      value,
    });
  }
}
