import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryCache } from "../src/discovery/cache.js";
import { MockChainReader } from "./helpers/mockChain.js";
import type { Hex } from "../src/types.js";

// Unit tests for the cache's failure-mode hardening: a failed refresh must
// keep serving the last-known-good card (bounded by the staleness cap)
// instead of degrading the provider, and the refresh loop must fast-retry
// while a provider has never yielded a card (gateway boot racing a
// provider deploy). Drives DiscoveryCache directly — no HTTP server, no DB.

const WALLET_A = "0x00000000000000000000000000000000000000aa" as Hex;
const WALLET_B = "0x00000000000000000000000000000000000000bb" as Hex;
const AGENT_URI = "http://127.0.0.1:9/agent-cards/1.json";

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
    url: "http://127.0.0.1:9/a2a",
    skills: [
      { id: "register-domain", name: "Register Domain", description: "d" },
    ],
  };
}

interface Harness {
  cache: DiscoveryCache;
  chain: MockChainReader;
  fetchFn: ReturnType<typeof vi.fn>;
  /** Flip to make every subsequent card fetch 500. */
  setFailing(failing: boolean): void;
}

function buildHarness(opts?: {
  maxCardStalenessSeconds?: number;
  refreshIntervalSeconds?: number;
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
  const fetchFn = vi.fn(async (_url: string) =>
    failing
      ? jsonResponse({ error: "warming up" }, 500)
      : jsonResponse(agentCard("Domains")),
  );

  const cache = new DiscoveryCache({
    reader: chain,
    whitelist: [1n],
    refreshIntervalSeconds: opts?.refreshIntervalSeconds ?? 60,
    maxCardStalenessSeconds: opts?.maxCardStalenessSeconds ?? 3600,
    fetch: fetchFn,
    logger: quietLogger,
  });

  return {
    cache,
    chain,
    fetchFn,
    setFailing(f: boolean) {
      failing = f;
    },
  };
}

describe("DiscoveryCache failure hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect((kept.agentCard as { name?: string }).name).toBe("Domains");
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
    expect(degraded.agentCard).toEqual({});
    expect(degraded.providerName).toBeNull();
    expect(degraded.fetchError).toMatch(/HTTP 500/);
  });

  it("creates a card-less placeholder for a provider that has never been fetched", async () => {
    const h = buildHarness();
    h.setFailing(true);
    await h.cache.refresh();
    const placeholder = h.cache.get(1n)!;
    expect(placeholder.cards).toEqual([]);
    expect(placeholder.agentCard).toEqual({});
    expect(placeholder.fetchError).toMatch(/HTTP 500/);
    expect(placeholder.walletAddress).toBe(WALLET_A);
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
    // resolves the card.
    h.setFailing(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(4);
    expect(h.cache.get(1n)!.cards).toHaveLength(1);
    expect(h.cache.get(1n)!.fetchError).toBeNull();

    // With a healthy catalog the loop runs at the normal interval again.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(5);

    // stop() cancels the loop.
    h.cache.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(5);
  });

  it("healthy catalogs never see the fast fuse (steady state unchanged)", async () => {
    vi.useFakeTimers();
    const h = buildHarness({ refreshIntervalSeconds: 60 });
    await h.cache.refresh();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    h.cache.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    h.cache.stop();
  });
});
