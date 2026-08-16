import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { DirectReputationReader, presentReputation } from "../src/standardRail/reputationReader.js";

describe("direct reputation presentation", () => {
  it("preserves the public shape while deriving finalized on-chain rates", () => {
    expect(presentReputation({
      completed: 3n,
      failed: 1n,
      canceled: 0n,
      confirmed: 2n,
      notConfirmed: 1n,
      transactions: 5n,
      totalPaid: 10_000_000n,
      totalRefunded: 0n,
      confirmedWeight: 9n,
      notConfirmedWeight: 1n,
      outcomeDelayTotal: 400n,
    }, 123n)).toEqual({
      transactionCount: "5",
      completedCount: "3",
      failedCount: "1",
      canceledCount: "0",
      completionSampleSize: "4",
      completionRate: 75,
      confirmedCount: "2",
      notConfirmedCount: "1",
      confirmationSampleSize: "3",
      buyerSatisfactionRate: 66.66,
      valueWeightedBuyerSatisfactionRate: 90,
      totalPaid: "10000000",
      totalRefunded: "0",
      averageFulfillmentSeconds: 100,
      fulfillmentSampleSize: "4",
      recentPurchases: [],
      finalizedBlock: "123",
    });
  });

  it("reports unavailable samples without inventing a score", () => {
    const result = presentReputation({
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
      transactions: 0n,
      totalPaid: 0n,
      totalRefunded: 0n,
      confirmedWeight: 0n,
      notConfirmedWeight: 0n,
    }, 456n);
    expect(result.completionRate).toBeNull();
    expect(result.buyerSatisfactionRate).toBeNull();
    expect(result.valueWeightedBuyerSatisfactionRate).toBeNull();
    expect(result.averageFulfillmentSeconds).toBeNull();
    expect(result.fulfillmentSampleSize).toBe("0");
  });

  it("reuses one finalized reputation snapshot within the cache window", async () => {
    const getBlock = vi.fn(async () => ({ number: 123n }));
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getProviderStats") return [0n, 0n, 0n, 0n, 0n, 0n];
      if (functionName === "getServiceStats") return [0n, 0n, 0n, 0n, 0n, 0n, 0n];
      return 0n;
    });
    const reader = new DirectReputationReader({
      evidenceRpcUrls: ["https://rpc.example"],
      reputationContract: "0x1111111111111111111111111111111111111111",
    } as unknown as StandardRailConfig, baseSepolia);
    Object.assign(reader as unknown as { client: unknown }, { client: { getBlock, readContract } });
    const outcomes = [{ providerAgentId: "1", serviceId: `0x${"22".repeat(32)}` }];

    await reader.forOutcomes(outcomes);
    await reader.forOutcomes(outcomes);

    expect(getBlock).toHaveBeenCalledOnce();
    expect(readContract).toHaveBeenCalledTimes(10);
  });
});
