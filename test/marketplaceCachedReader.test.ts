import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { CachedMarketplaceChainReader } from "../src/marketplace/cachedReader.js";
import type { MarketplaceChainReader, RecoveredFigure } from "../src/marketplace/reader.js";

const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;

function source() {
  return {
    addresses: {} as MarketplaceChainReader["addresses"],
    resolveWallet: vi.fn(async () => ({ agentId: "7", found: true })),
    listProviders: vi.fn(async () => ({ total: "1" })),
    getProvider: vi.fn(async () => ({ agentId: "7" })),
    getService: vi.fn(async () => ({ serviceId: SERVICE_ID } as never)),
    readRecovered: vi.fn(async (figure: RecoveredFigure) => figure.kind === "provider" ? "3" : "2"),
  };
}

describe("cached marketplace reader", () => {
  it("serves repeated registry reads from the shared cache until the TTL lapses", async () => {
    vi.useFakeTimers();
    try {
      const inner = source();
      const reader = new CachedMarketplaceChainReader(inner as unknown as MarketplaceChainReader);
      await reader.listProviders(0, 20);
      await reader.listProviders(0, 20);
      await reader.getService(SERVICE_ID);
      await reader.getService(SERVICE_ID);
      expect(inner.listProviders).toHaveBeenCalledOnce();
      expect(inner.getService).toHaveBeenCalledOnce();

      await reader.listProviders(0, 50);
      expect(inner.listProviders).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(61_000);
      await reader.listProviders(0, 20);
      expect(inner.listProviders).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache failed reads", async () => {
    const inner = source();
    inner.getProvider.mockRejectedValueOnce(new Error("boom"));
    const reader = new CachedMarketplaceChainReader(inner as unknown as MarketplaceChainReader);
    await expect(reader.getProvider(7n)).rejects.toThrow("boom");
    await expect(reader.getProvider(7n)).resolves.toMatchObject({ agentId: "7" });
    expect(inner.getProvider).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good value while refreshes fail", async () => {
    vi.useFakeTimers();
    try {
      const inner = source();
      const reader = new CachedMarketplaceChainReader(inner as unknown as MarketplaceChainReader);
      const first = await reader.getService(SERVICE_ID);

      vi.advanceTimersByTime(61_000);
      inner.getService.mockRejectedValue(new Error("RPC_DOWN"));
      await expect(reader.getService(SERVICE_ID)).resolves.toEqual(first);
      expect(inner.getService).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops serving stale values past the stale window", async () => {
    vi.useFakeTimers();
    try {
      const inner = source();
      const reader = new CachedMarketplaceChainReader(inner as unknown as MarketplaceChainReader);
      await reader.getService(SERVICE_ID);

      vi.advanceTimersByTime(24 * 60 * 60_000 + 1_000);
      inner.getService.mockRejectedValue(new Error("RPC_DOWN"));
      await expect(reader.getService(SERVICE_ID)).rejects.toThrow("RPC_DOWN");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches recovered figures per figure and safe block until the TTL lapses", async () => {
    vi.useFakeTimers();
    try {
      const inner = source();
      const reader = new CachedMarketplaceChainReader(inner as unknown as MarketplaceChainReader);
      const serviceId = `0x${"ab".repeat(32)}` as Hex;

      await expect(reader.readRecovered({ kind: "service", serviceId }, 110n)).resolves.toBe("2");
      // The same service id in other letter case is the same entry.
      await expect(reader.readRecovered({
        kind: "service",
        serviceId: `0x${"AB".repeat(32)}` as Hex,
      }, 110n)).resolves.toBe("2");
      expect(inner.readRecovered).toHaveBeenCalledOnce();

      await expect(reader.readRecovered({ kind: "service", serviceId }, 111n)).resolves.toBe("2");
      await expect(reader.readRecovered({ kind: "provider", agentId: 7n }, 110n)).resolves.toBe("3");
      expect(inner.readRecovered).toHaveBeenCalledTimes(3);
      expect(inner.readRecovered).toHaveBeenLastCalledWith({ kind: "provider", agentId: 7n }, 110n);

      vi.advanceTimersByTime(61_000);
      await reader.readRecovered({ kind: "provider", agentId: 7n }, 110n);
      expect(inner.readRecovered).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
