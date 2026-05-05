import {
  fetchOnChainProviders,
  type ChainReader,
} from "../chain/reader.js";
import type { CachedProvider, OnChainProvider } from "../types.js";
import {
  readBoundedJson,
  validateUrlForOutbound,
} from "../util/urlSafety.js";

// 256 KB is enough for any well-formed Agent Card (largest live one is ~12 KB).
// A whitelisted-but-malicious provider serving a multi-GB JSON body would
// otherwise OOM the gateway via `res.json()` on every refresh.
const AGENT_CARD_MAX_BYTES = 256 * 1024;

export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CacheOptions {
  reader: ChainReader;
  whitelist: bigint[];
  refreshIntervalSeconds: number;
  fetch?: FetchFn;
  agentCardFetchTimeoutMs?: number;
  onCatalogChanged?: (
    oldProviders: CachedProvider[],
    newProviders: CachedProvider[],
  ) => void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export class DiscoveryCache {
  private cache: Map<string, CachedProvider> = new Map();
  private lastRefresh: Date | null = null;
  private readonly reader: ChainReader;
  // Owned copy of the whitelist — callers must use setWhitelist() to mutate it.
  private whitelist: bigint[];
  private readonly refreshIntervalMs: number;
  private readonly fetchFn: FetchFn;
  private readonly agentCardFetchTimeoutMs: number;
  private onCatalogChanged?: (
    oldProviders: CachedProvider[],
    newProviders: CachedProvider[],
  ) => void;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: CacheOptions) {
    this.reader = opts.reader;
    this.whitelist = [...opts.whitelist];
    this.refreshIntervalMs = opts.refreshIntervalSeconds * 1000;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.agentCardFetchTimeoutMs = opts.agentCardFetchTimeoutMs ?? 5000;
    this.onCatalogChanged = opts.onCatalogChanged;
    this.logger = opts.logger ?? console;
  }

  setOnCatalogChanged(
    cb: (
      oldProviders: CachedProvider[],
      newProviders: CachedProvider[],
    ) => void,
  ): void {
    this.onCatalogChanged = cb;
  }

  setWhitelist(ids: bigint[]): void {
    this.whitelist = [...ids];
  }

  getWhitelist(): bigint[] {
    return [...this.whitelist];
  }

  getAll(): CachedProvider[] {
    return [...this.cache.values()].sort((a, b) =>
      a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
    );
  }

  get(agentId: bigint): CachedProvider | undefined {
    return this.cache.get(agentId.toString());
  }

  getLastRefresh(): Date | null {
    return this.lastRefresh;
  }

  async refresh(): Promise<void> {
    const oldSnapshot = this.getAll();
    let onChain: OnChainProvider[];
    try {
      onChain = await fetchOnChainProviders(this.reader, this.whitelist);
    } catch (err) {
      this.logger.error(
        `[cache] failed to read provider registry: ${(err as Error).message}`,
      );
      return;
    }

    const nextCache = new Map<string, CachedProvider>();

    for (const provider of onChain) {
      const existing = this.cache.get(provider.agentId.toString());
      try {
        const agentCard = await this.resolveAgentCard(provider.agentURI);
        nextCache.set(provider.agentId.toString(), {
          agentId: provider.agentId,
          walletAddress: provider.walletAddress,
          agentURI: provider.agentURI,
          agentCard,
          lastFetched: new Date(),
          fetchError: null,
        });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        this.logger.warn(
          `[cache] failed to fetch agent card from ${provider.agentURI}: ${message}`,
        );
        if (existing) {
          nextCache.set(provider.agentId.toString(), {
            ...existing,
            fetchError: message,
          });
        } else {
          nextCache.set(provider.agentId.toString(), {
            agentId: provider.agentId,
            walletAddress: provider.walletAddress,
            agentURI: provider.agentURI,
            agentCard: {},
            lastFetched: new Date(),
            fetchError: message,
          });
        }
      }
    }

    this.cache = nextCache;
    this.lastRefresh = new Date();

    const newSnapshot = this.getAll();
    if (this.onCatalogChanged && this.hasChanged(oldSnapshot, newSnapshot)) {
      try {
        this.onCatalogChanged(oldSnapshot, newSnapshot);
      } catch (err) {
        this.logger.error(
          `[cache] onCatalogChanged callback threw: ${(err as Error).message}`,
        );
      }
    }
  }

  private hasChanged(
    oldProviders: CachedProvider[],
    newProviders: CachedProvider[],
  ): boolean {
    if (oldProviders.length !== newProviders.length) return true;
    for (let i = 0; i < oldProviders.length; i++) {
      const o = oldProviders[i];
      const n = newProviders[i];
      if (o.agentId !== n.agentId) return true;
      if (JSON.stringify(o.agentCard) !== JSON.stringify(n.agentCard)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves a provider's Agent Card from its ERC-8004 agentURI.
   *
   * The spec says agentURI points to the agent registration file (JSON with a
   * `services` array). The A2A Agent Card lives at the endpoint of the entry
   * whose `name` is "A2A" (typically `…/.well-known/agent.json` or
   * `…/.well-known/agent-card.json`).
   *
   * For backwards compatibility with pre-ERC-8004 providers that serve a
   * flat Agent Card directly at agentURI, we treat the response as an Agent
   * Card when it does NOT look like a registration file — specifically when
   * it lacks a `services` array or the A2A entry is missing.
   */
  private async resolveAgentCard(
    agentURI: string,
  ): Promise<Record<string, unknown>> {
    const doc = await this.fetchJson(agentURI);

    const services = doc["services"];
    if (Array.isArray(services)) {
      const a2a = services.find(
        (s: any) => s && typeof s === "object" && s.name === "A2A",
      );
      if (a2a && typeof a2a.endpoint === "string") {
        return await this.fetchJson(a2a.endpoint);
      }
      // No A2A endpoint — the registration file itself has no Agent Card to
      // serve. Return the registration doc so downstream callers at least
      // see the ERC-8004 metadata.
      return doc;
    }

    // Flat Agent Card (pre-ERC-8004 layout).
    return doc;
  }

  private async fetchJson(uri: string): Promise<Record<string, unknown>> {
    // Pre-flight: reject schemes other than http/https and hostnames that
    // resolve to private/loopback/link-local space (AWS IMDS, localhost
    // RPC ports, internal services). A whitelisted-but-malicious provider
    // who controls their on-chain `agentURI` could otherwise pivot the
    // gateway's outbound fetch into the cluster's internal network.
    await validateUrlForOutbound(uri);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.agentCardFetchTimeoutMs,
    );
    try {
      // `redirect: "manual"` so a 30x to a private host doesn't slip past
      // the validator. Tests inject `fetchFn` and use 127.0.0.1 URLs;
      // urlSafety short-circuits the host check when NODE_ENV=test.
      const res = await this.fetchFn(uri, {
        signal: controller.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          const next = new URL(loc, uri).toString();
          await validateUrlForOutbound(next);
          // Single redirect hop only: real Agent Card hosts don't need
          // chains, and longer chains are an attacker's preferred way to
          // smuggle a private-host target in.
          const innerController = new AbortController();
          const innerTimer = setTimeout(
            () => innerController.abort(),
            this.agentCardFetchTimeoutMs,
          );
          try {
            const followed = await this.fetchFn(next, {
              signal: innerController.signal,
              redirect: "manual",
            });
            if (!followed.ok) {
              throw new Error(`HTTP ${followed.status}`);
            }
            const json = await readBoundedJson<Record<string, unknown>>(
              followed,
              AGENT_CARD_MAX_BYTES,
            );
            if (typeof json !== "object" || json === null) {
              throw new Error("Agent card is not an object");
            }
            return json;
          } finally {
            clearTimeout(innerTimer);
          }
        }
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await readBoundedJson<Record<string, unknown>>(
        res,
        AGENT_CARD_MAX_BYTES,
      );
      if (typeof json !== "object" || json === null) {
        throw new Error("Agent card is not an object");
      }
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
