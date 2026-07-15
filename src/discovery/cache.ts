import {
  fetchOnChainProviders,
  type ChainReader,
} from "../chain/reader.js";
import type { CachedProvider, OnChainProvider, ProviderCard } from "../types.js";
import { extractCardServiceSlug } from "./format.js";
import { assertValidServiceTaxonomy } from "./taxonomyValidation.js";
import {
  readBoundedJson,
  safeFetch,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../util/urlSafety.js";
import type { ProviderLegalMetadata } from "../legal/types.js";
import {
  parseProviderLegalMetadata,
  ProviderLegalValidationError,
} from "../legal/validation.js";

// 256 KB is enough for any well-formed Agent Card (largest live one is ~12 KB).
// A whitelisted-but-malicious provider serving a multi-GB JSON body would
// otherwise OOM the gateway via `res.json()` on every refresh.
const AGENT_CARD_MAX_BYTES = 256 * 1024;

// How long a provider's last-known-good cards keep being served after the
// most recent successful fetch. Serving stale is safe for paid flows — a
// purchase still requires a live signed /quote from the provider, so a
// stale card can't take a buyer's money while the provider is down. The
// cap exists so a provider that has been unreachable for a long time
// eventually stops appearing purchasable in the catalog.
const DEFAULT_MAX_CARD_STALENESS_SECONDS = 24 * 60 * 60;

// First-retry delay while a whitelisted provider has no resolvable card
// yet (typically: the gateway booted while the provider was still warming
// up and its card endpoint 500'd). Doubles on every cardless tick until it
// reaches the regular refresh interval, so a provider that stays dead
// costs a handful of extra fetches, not a hot loop.
const FAST_RETRY_BASE_MS = 15_000;

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
  /**
   * Staleness cap for last-known-good serving: when a refresh fails, the
   * previously fetched cards keep being served until they are older than
   * this. Past the cap the provider degrades to a card-less placeholder
   * (visible in /discover with fetchError, absent from search, not
   * purchasable) until a fetch succeeds again. Default 24h.
   */
  maxCardStalenessSeconds?: number;
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
  private readonly maxCardStalenessMs: number;
  private readonly fetchFn: FetchFn;
  private readonly agentCardFetchTimeoutMs: number;
  private onCatalogChanged?: (
    oldProviders: CachedProvider[],
    newProviders: CachedProvider[],
  ) => void;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private fastRetryDelayMs = FAST_RETRY_BASE_MS;

  constructor(opts: CacheOptions) {
    this.reader = opts.reader;
    this.whitelist = [...opts.whitelist];
    this.refreshIntervalMs = opts.refreshIntervalSeconds * 1000;
    this.maxCardStalenessMs =
      (opts.maxCardStalenessSeconds ?? DEFAULT_MAX_CARD_STALENESS_SECONDS) *
      1000;
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
          providerLegal: resolved.providerLegal,
          lastFetched: new Date(),
          fetchError: resolved.partialError,
        });
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const hardLegalFailure = err instanceof ProviderLegalValidationError;
        this.logger.warn(
          `[cache] failed to fetch agent card from ${provider.agentURI}: ${message}`,
        );
        // Serve the last-known-good cards through transient provider
        // outages (deploy warm-up 500s, card-host flake) so a single
        // failed tick doesn't delist a provider that was purchasable
        // seconds earlier — but only up to the staleness cap.
        const hasKnownGoodCard =
          existing !== undefined &&
          ((existing.cards?.length ?? 0) > 0 ||
            Object.keys(existing.agentCard).length > 0);
        const withinStalenessCap =
          existing !== undefined &&
          Date.now() - existing.lastFetched.getTime() <=
            this.maxCardStalenessMs;
        if (
          !hardLegalFailure &&
          existing &&
          hasKnownGoodCard &&
          withinStalenessCap
        ) {
          // Only the provider's HTTP surface failed; the on-chain read
          // succeeded, so keep wallet + agentURI live (payee rotation
          // must propagate even while the card host is down).
          nextCache.set(provider.agentId.toString(), {
            ...existing,
            walletAddress: provider.walletAddress,
            agentURI: provider.agentURI,
            fetchError: message,
          });
        } else {
          if (hasKnownGoodCard) {
            const reason = hardLegalFailure
              ? "provider legal metadata is invalid"
              : `staleness cap ${this.maxCardStalenessMs / 1000}s exceeded`;
            this.logger.warn(
              `[cache] dropping agent ${provider.agentId}'s last-known-good ` +
                `card: ${reason}`,
            );
          }
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
            providerLegal: null,
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
      if (JSON.stringify(o.providerLegal) !== JSON.stringify(n.providerLegal)) {
        return true;
      }
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
   * throws (the caller keeps serving the previous snapshot, with
   * fetchError set, until the staleness cap expires).
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
    providerLegal: ProviderLegalMetadata;
    partialError: string | null;
  }> {
    const doc = await this.fetchJson(agentURI);
    const providerLegal = parseProviderLegalMetadata(doc);

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
            assertValidServiceTaxonomy(agentCard);
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
          providerLegal,
          partialError:
            errors.length > 0 ? `partial card fetch: ${errors.join("; ")}` : null,
        };
      }
      // A registration document without an A2A entry is admitted only if it
      // is itself a complete marketplace Agent Card. Taxonomy validation
      // rejects ordinary registration metadata before it reaches the cache.
      assertValidServiceTaxonomy(doc);
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
        providerLegal,
        partialError: null,
      };
    }

    // Flat Agent Card (pre-ERC-8004 layout). No registration-level identity
    // is available in this shape.
    assertValidServiceTaxonomy(doc);
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
      providerLegal,
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
    if (this.running) return;
    this.running = true;
    this.scheduleNextRefresh();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Self-scheduling refresh loop. Unlike the previous setInterval, the
   * next tick is armed only after the current refresh finishes, so a slow
   * provider can never stack overlapping refreshes. While any whitelisted
   * provider has never yielded a card this process (gateway boot racing a
   * provider deploy — there is no last-known-good to serve yet), the next
   * tick comes on a short exponential-backoff fuse instead of a full
   * refresh interval, shrinking the deploy-day catalog gap from minutes
   * to seconds.
   */
  private scheduleNextRefresh(): void {
    if (!this.running) return;
    let delayMs = this.refreshIntervalMs;
    if (this.hasProviderAwaitingFirstCard()) {
      delayMs = Math.min(this.fastRetryDelayMs, this.refreshIntervalMs);
      this.fastRetryDelayMs = Math.min(
        this.fastRetryDelayMs * 2,
        this.refreshIntervalMs,
      );
    } else {
      this.fastRetryDelayMs = FAST_RETRY_BASE_MS;
    }
    this.timer = setTimeout(() => {
      void this.refresh()
        .catch((err) => {
          // refresh() contains its own error handling; this guard only
          // exists so an unexpected throw can't kill the loop.
          this.logger.error(
            `[cache] refresh threw: ${(err as Error).message}`,
          );
        })
        .finally(() => this.scheduleNextRefresh());
    }, delayMs);
  }

  /** True while the registry has never been read, or any cached provider
   *  is a card-less placeholder (no successful card fetch to fall back
   *  on — the case the fast-retry fuse exists for). */
  private hasProviderAwaitingFirstCard(): boolean {
    if (this.lastRefresh === null) return true;
    for (const p of this.cache.values()) {
      if (
        (p.cards?.length ?? 0) === 0 &&
        Object.keys(p.agentCard).length === 0
      ) {
        return true;
      }
    }
    return false;
  }
}
