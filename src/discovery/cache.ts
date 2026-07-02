import {
  fetchOnChainProviders,
  type ChainReader,
} from "../chain/reader.js";
import type { CachedProvider, OnChainProvider, ProviderCard } from "../types.js";
import { extractCardServiceSlug } from "./format.js";
import {
  readBoundedJson,
  safeFetch,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../util/urlSafety.js";

// 256 KB is enough for any well-formed Agent Card (largest live one is ~12 KB).
// A whitelisted-but-malicious provider serving a multi-GB JSON body would
// otherwise OOM the gateway via `res.json()` on every refresh.
const AGENT_CARD_MAX_BYTES = 256 * 1024;

function strField(doc: Record<string, unknown>, key: string): string | null {
  const v = doc[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type FetchFn = (
  url: string,
  init?: RequestInit,
  preValidated?: ValidatedUrl,
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
    // Default to safeFetch in production: validates the host AND pins the
    // resolved IP at connect time so a hostile DNS server can't flip an A
    // record between validate and dial. Tests inject their own fetchFn
    // (mockProvider on 127.0.0.1) which is unaffected.
    this.fetchFn = opts.fetch ?? safeFetch;
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
        const resolved = await this.resolveAgentCard(provider.agentURI);
        nextCache.set(provider.agentId.toString(), {
          agentId: provider.agentId,
          walletAddress: provider.walletAddress,
          agentURI: provider.agentURI,
          agentCard: resolved.cards[0]!.agentCard,
          cards: resolved.cards,
          providerName: resolved.providerName,
          providerDescription: resolved.providerDescription,
          providerImage: resolved.providerImage,
          providerExternalUrl: resolved.providerExternalUrl,
          lastFetched: new Date(),
          fetchError: resolved.partialError,
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
            cards: [],
            providerName: null,
            providerDescription: null,
            providerImage: null,
            providerExternalUrl: null,
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
      if (o.providerName !== n.providerName) return true;
      if (o.providerDescription !== n.providerDescription) return true;
      // Compare the full card set — a provider adding/removing a service
      // is a catalog change even when its first card is untouched.
      if (JSON.stringify(o.cards ?? []) !== JSON.stringify(n.cards ?? [])) {
        return true;
      }
      if (JSON.stringify(o.agentCard) !== JSON.stringify(n.agentCard)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves a provider's Agent Cards from its ERC-8004 agentURI, alongside
   * the provider-level name/description on the registration file.
   *
   * The spec says agentURI points to the agent registration file (JSON with
   * a `services` array). A multi-service provider lists ONE entry named
   * "A2A" per service — every entry is fetched and becomes a card in the
   * catalog. Top-level `name` and `description` on the registration file
   * describe the *provider* (operating entity) and are kept separately so
   * callers can render provider identity without re-fetching.
   *
   * Per-card fetch failures are tolerated as long as at least one card
   * resolves: the failing endpoint is skipped and recorded in
   * `partialError` so operators can see the gap without one broken
   * service delisting the provider's healthy ones. Zero resolvable cards
   * throws (the caller keeps the previous snapshot with fetchError set).
   *
   * For backwards compatibility with pre-ERC-8004 providers that serve a
   * flat Agent Card directly at agentURI, we treat the response as a
   * single card when it does NOT look like a registration file —
   * specifically when it lacks a `services` array or no A2A entry is
   * present. In that legacy shape we have no separate provider identity,
   * so providerName / providerDescription are null.
   */
  private async resolveAgentCard(agentURI: string): Promise<{
    cards: ProviderCard[];
    providerName: string | null;
    providerDescription: string | null;
    providerImage: string | null;
    providerExternalUrl: string | null;
    partialError: string | null;
  }> {
    const doc = await this.fetchJson(agentURI);

    const services = doc["services"];
    if (Array.isArray(services)) {
      const providerName = strField(doc, "name");
      const providerDescription = strField(doc, "description");
      // ERC-8004 §registration-v1 / ERC-721 metadata. `image` is the
      // canonical icon slot; `external_url` is the ERC-721/OpenSea
      // convention for a project homepage. Both are SHOULD-level, so
      // null is the steady state for providers who haven't filled them.
      const providerImage = strField(doc, "image");
      const providerExternalUrl = strField(doc, "external_url");
      const a2aEntries = services.filter(
        (s: any) =>
          s &&
          typeof s === "object" &&
          s.name === "A2A" &&
          typeof s.endpoint === "string" &&
          s.endpoint.length > 0,
      ) as Array<{ endpoint: string }>;

      if (a2aEntries.length > 0) {
        const cards: ProviderCard[] = [];
        const errors: string[] = [];
        for (const entry of a2aEntries) {
          try {
            const agentCard = await this.fetchJson(entry.endpoint);
            cards.push({
              endpoint: entry.endpoint,
              serviceSlug: extractCardServiceSlug(agentCard),
              agentCard,
            });
          } catch (err) {
            const message = (err as Error).message ?? String(err);
            errors.push(`${entry.endpoint}: ${message}`);
            this.logger.warn(
              `[cache] failed to fetch agent card from ${entry.endpoint}: ${message}`,
            );
          }
        }
        if (cards.length === 0) {
          throw new Error(
            `all ${a2aEntries.length} agent card endpoint(s) failed: ${errors.join("; ")}`,
          );
        }
        return {
          cards,
          providerName,
          providerDescription,
          providerImage,
          providerExternalUrl,
          partialError:
            errors.length > 0 ? `partial card fetch: ${errors.join("; ")}` : null,
        };
      }
      // No A2A endpoint — the registration file itself has no Agent Card to
      // serve. Return the registration doc so downstream callers at least
      // see the ERC-8004 metadata.
      return {
        cards: [
          {
            endpoint: agentURI,
            serviceSlug: extractCardServiceSlug(doc),
            agentCard: doc,
          },
        ],
        providerName,
        providerDescription,
        providerImage,
        providerExternalUrl,
        partialError: null,
      };
    }

    // Flat Agent Card (pre-ERC-8004 layout). No registration-level identity
    // is available in this shape.
    return {
      cards: [
        {
          endpoint: agentURI,
          serviceSlug: extractCardServiceSlug(doc),
          agentCard: doc,
        },
      ],
      providerName: null,
      providerDescription: null,
      providerImage: null,
      providerExternalUrl: null,
      partialError: null,
    };
  }

  private async fetchJson(uri: string): Promise<Record<string, unknown>> {
    // Pre-flight: reject schemes other than http/https and hostnames that
    // resolve to private/loopback/link-local space (AWS IMDS, localhost
    // RPC ports, internal services). A whitelisted-but-malicious provider
    // who controls their on-chain `agentURI` could otherwise pivot the
    // gateway's outbound fetch into the cluster's internal network.
    const validated = await validateUrlForOutbound(uri);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.agentCardFetchTimeoutMs,
    );
    try {
      // `redirect: "manual"` so a 30x to a private host doesn't slip past
      // the validator. Tests inject `fetchFn` and use 127.0.0.1 URLs;
      // urlSafety short-circuits the host check when NODE_ENV=test. The
      // validated URL is forwarded to safeFetch so it can pin the connect
      // to the IP we already resolved (no second DNS lookup).
      const res = await this.fetchFn(
        uri,
        { signal: controller.signal, redirect: "manual" },
        validated,
      );
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          const next = new URL(loc, uri).toString();
          const nextValidated = await validateUrlForOutbound(next);
          // Single redirect hop only: real Agent Card hosts don't need
          // chains, and longer chains are an attacker's preferred way to
          // smuggle a private-host target in.
          const innerController = new AbortController();
          const innerTimer = setTimeout(
            () => innerController.abort(),
            this.agentCardFetchTimeoutMs,
          );
          try {
            const followed = await this.fetchFn(
              next,
              { signal: innerController.signal, redirect: "manual" },
              nextValidated,
            );
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
