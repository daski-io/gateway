import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryCache } from "../src/discovery/cache.js";
import { MockChainReader } from "./helpers/mockChain.js";
import type { Hex } from "../src/types.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";

// Unit tests for the cache's failure-mode hardening: a failed refresh must
// keep serving the last-known-good card (bounded by the staleness cap)
// instead of degrading the provider, and the refresh loop must fast-retry
// while a provider has never yielded a card (gateway boot racing a
// provider deploy). Drives DiscoveryCache directly — no HTTP server, no DB.

const WALLET_A = "0x00000000000000000000000000000000000000aa" as Hex;
const WALLET_B = "0x00000000000000000000000000000000000000bb" as Hex;
const AGENT_URI = "http://127.0.0.1:9/registrations/1.json";
const CARD_URI = "http://127.0.0.1:9/agent-cards/1.json";

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function agentCard(name: string): Record<string, unknown> {
  return {
    name,
    supportedInterfaces: [
      {
        url: "http://127.0.0.1:9/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    skills: [
      {
        id: "register-domain",
        name: "Register Domain",
        description: "d",
      },
    ],
    extensions: {
      [DASKI_A2A_EXTENSION_URI]: {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["global"],
        skills: {
          "register-domain": {
            fulfillmentMode: "automated",
            serviceSlug: "domain-management",
          },
        },
      },
    },
  };
}

interface Harness {
  cache: DiscoveryCache;
  chain: MockChainReader;
  fetchFn: ReturnType<typeof vi.fn>;
  maxActiveCardFetches(): number;
  /** Flip to make every subsequent card fetch 500. */
  setFailing(failing: boolean): void;
}

function buildHarness(opts?: {
  whitelist?: bigint[];
  maxCardStalenessSeconds?: number;
  refreshIntervalSeconds?: number;
  maxA2AEntries?: number;
  serviceCount?: number;
  fetchConcurrency?: number;
  cardDelayMs?: number;
}): Harness {
  const chain = new MockChainReader();
  chain.addProvider(1n, {
    walletAddress: WALLET_A,
    agentId: 1n,
    agentURI: AGENT_URI,
    registrationTime: 1n,
    isActive: true,
  });

  let failing = false;
  let activeCardFetches = 0;
  let maxActiveCardFetches = 0;
  const fetchFn = vi.fn(async (url: string) => {
    if (failing) return jsonResponse({ error: "warming up" }, 500);
    if (url === AGENT_URI) {
      return jsonResponse({
        name: "Example Provider",
        legalName: "Example Provider, LLC",
        termsUrl: "https://provider.example/terms",
        privacyUrl: "https://provider.example/privacy",
        services: Array.from({ length: opts?.serviceCount ?? 1 }, () => ({
          name: "A2A",
          endpoint: CARD_URI,
        })),
      });
    }
    activeCardFetches += 1;
    maxActiveCardFetches = Math.max(maxActiveCardFetches, activeCardFetches);
    if (opts?.cardDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.cardDelayMs));
    }
    activeCardFetches -= 1;
    return jsonResponse(agentCard("Domains"));
  });

  const cache = new DiscoveryCache({
    reader: chain,
    whitelist: opts?.whitelist ?? [1n],
    refreshIntervalSeconds: opts?.refreshIntervalSeconds ?? 60,
    maxCardStalenessSeconds: opts?.maxCardStalenessSeconds ?? 3600,
    maxA2AEntries: opts?.maxA2AEntries,
    fetchConcurrency: opts?.fetchConcurrency,
    fetch: fetchFn,
    logger: quietLogger,
  });

  return {
    cache,
    chain,
    fetchFn,
    maxActiveCardFetches() {
      return maxActiveCardFetches;
    },
    setFailing(f: boolean) {
      failing = f;
    },
  };
}

describe("DiscoveryCache failure hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits active providers when the whitelist is empty", async () => {
    const h = buildHarness({ whitelist: [] });
    await h.cache.refresh();

    expect(h.cache.get(1n)).toBeDefined();
    expect(h.cache.get(1n)!.cards).toHaveLength(1);
  });

  it("keeps serving the last-known-good card when a refresh fetch fails", async () => {
    const h = buildHarness();
    await h.cache.refresh();
    const fresh = h.cache.get(1n)!;
    expect(fresh.fetchError).toBeNull();
    expect(fresh.cards).toHaveLength(1);
    const goodFetchTime = fresh.lastFetched.getTime();

    h.setFailing(true);
    await h.cache.refresh();
    const kept = h.cache.get(1n)!;
    expect(kept.fetchError).toMatch(/HTTP 500/);
    // The card survives the failed tick — this is what keeps purchases
    // working through a provider's deploy warm-up.
    expect(kept.cards).toHaveLength(1);
    expect((kept.cards[0]!.agentCard as { name?: string }).name).toBe("Domains");
    // lastFetched still marks the last GOOD fetch, not the failed attempt.
    expect(kept.lastFetched.getTime()).toBe(goodFetchTime);

    // Repeated failures inside the cap keep the card too.
    await h.cache.refresh();
    expect(h.cache.get(1n)!.cards).toHaveLength(1);
  });

  it("refreshes on-chain fields (wallet rotation) even while the card fetch fails", async () => {
    const h = buildHarness();
    await h.cache.refresh();
    expect(h.cache.get(1n)!.walletAddress).toBe(WALLET_A);

    h.chain.setAgentWallet(1n, WALLET_B);
    h.setFailing(true);
    await h.cache.refresh();
    const kept = h.cache.get(1n)!;
    // Chain read succeeded — the live payee must propagate so quote
    // signature validation doesn't pin a rotated-away wallet.
    expect(kept.walletAddress).toBe(WALLET_B);
    expect(kept.cards).toHaveLength(1);
  });

  it("degrades to a card-less placeholder once the staleness cap is exceeded", async () => {
    const h = buildHarness({ maxCardStalenessSeconds: 3600 });
    await h.cache.refresh();

    // Backdate the last good fetch beyond the cap, then fail a refresh.
    const entry = h.cache.get(1n)!;
    entry.lastFetched = new Date(Date.now() - 2 * 3600 * 1000);

    h.setFailing(true);
    await h.cache.refresh();
    const degraded = h.cache.get(1n)!;
    // Still present (it IS whitelisted on-chain) but no longer offers a
    // stale card: invisible to search, not purchasable, fetchError set.
    expect(degraded.cards).toEqual([]);
    expect(degraded.providerName).toBeNull();
    expect(degraded.providerLegal).toBeNull();
    expect(degraded.fetchError).toMatch(/HTTP 500/);
  });

  it("creates a card-less placeholder for a provider that has never been fetched", async () => {
    const h = buildHarness();
    h.setFailing(true);
    await h.cache.refresh();
    const placeholder = h.cache.get(1n)!;
    expect(placeholder.cards).toEqual([]);
    expect(placeholder.fetchError).toMatch(/HTTP 500/);
    expect(placeholder.walletAddress).toBe(WALLET_A);
  });

  it("rejects registration files with excessive A2A fan-out", async () => {
    const h = buildHarness({
      maxA2AEntries: 2,
      serviceCount: 3,
    });
    await h.cache.refresh();
    const placeholder = h.cache.get(1n)!;
    expect(placeholder.cards).toEqual([]);
    expect(placeholder.fetchError).toMatch(/maximum is 2/);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent A2A card fetches", async () => {
    const h = buildHarness({
      maxA2AEntries: 4,
      serviceCount: 4,
      fetchConcurrency: 2,
      cardDelayMs: 10,
    });
    await h.cache.refresh();
    expect(h.cache.get(1n)!.cards).toHaveLength(4);
    expect(h.maxActiveCardFetches()).toBe(2);
  });

  it("fast-retries with backoff while a provider awaits its first card, then settles to the normal interval", async () => {
    vi.useFakeTimers();
    const h = buildHarness({ refreshIntervalSeconds: 60 });

    // Boot sequence: initial refresh races the provider's warm-up and
    // fails — exactly the deploy-day incident.
    h.setFailing(true);
    await h.cache.refresh();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.cache.get(1n)!.cards).toEqual([]);

    h.cache.start();

    // First retry comes on the 15s fuse, not the 60s interval.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);

    // Still failing — backoff doubles to 30s.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);

    // Provider finishes warming up; next retry (capped at the interval)
    // resolves the registration document and its Agent Card.
    h.setFailing(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(5);
    expect(h.cache.get(1n)!.cards).toHaveLength(1);
    expect(h.cache.get(1n)!.fetchError).toBeNull();

    // With a healthy catalog the loop runs at the normal interval again.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(7);

    // stop() cancels the loop.
    h.cache.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(7);
  });

  it("healthy catalogs never see the fast fuse (steady state unchanged)", async () => {
    vi.useFakeTimers();
    const h = buildHarness({ refreshIntervalSeconds: 60 });
    await h.cache.refresh();
    expect(h.fetchFn).toHaveBeenCalledTimes(2);

    h.cache.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(4);
    h.cache.stop();
  });
});
