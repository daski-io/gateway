import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { DirectReputationReader, presentReputation } from "../src/standardRail/reputationReader.js";
import { logger } from "../src/util/logger.js";
import type { ProjectedReputationRecord } from "../src/standardRail/reputationProjection.js";

const ORDER_KEY = `0x${"11".repeat(32)}` as Hex;
const SERVICE_ID = `0x${"22".repeat(32)}` as Hex;
const MANIFEST_HASH = `0x${"33".repeat(32)}` as Hex;
const TX_HASH = `0x${"44".repeat(32)}` as Hex;
const PAYER = getAddress("0x5555555555555555555555555555555555555555");
const ADDRESS = getAddress("0x1111111111111111111111111111111111111111");

function record(overrides: Partial<ProjectedReputationRecord> = {}): ProjectedReputationRecord {
  return {
    orderKey: ORDER_KEY,
    providerAgentId: "1",
    serviceId: SERVICE_ID,
    payer: PAYER,
    grossAmount: 1_000_000n,
    paidAt: 1_700_000_000n,
    outcome: 0,
    confirmation: 0,
    outcomeAttestationDelay: 0n,
    outcomeRecorded: false,
    reputationEligible: true,
    refundedAmount: 0n,
    settlementTransactionHash: null,
    buyerAgentId: null,
    buyerName: null,
    outcomeId: "register-domain",
    ...overrides,
  };
}

describe("direct reputation presentation", () => {
  it("derives public rows and completion timing from completed outcomes only", () => {
    const result = presentReputation([
      record({
        grossAmount: 4_000_000n,
        outcomeRecorded: true,
        outcome: 0,
        confirmation: 1,
        outcomeAttestationDelay: 100n,
        settlementTransactionHash: TX_HASH,
        buyerAgentId: "7",
        buyerName: "Test Buyer",
      }),
      record({
        orderKey: `0x${"12".repeat(32)}`,
        grossAmount: 1_000_000n,
        paidAt: 1_700_000_001n,
        outcomeRecorded: true,
        outcome: 0,
        confirmation: 1,
        outcomeAttestationDelay: 300n,
      }),
      record({
        orderKey: `0x${"13".repeat(32)}`,
        grossAmount: 250_000n,
        outcomeRecorded: true,
        outcome: 1,
        confirmation: 2,
        outcomeAttestationDelay: 900n,
        refundedAmount: 50_000n,
      }),
      record({ orderKey: `0x${"14".repeat(32)}`, grossAmount: 500_000n }),
    ], 123n);

    expect(result).toMatchObject({
      transactionCount: "4",
      completedCount: "2",
      failedCount: "1",
      completionSampleSize: "3",
      completionRate: 66.66,
      confirmedCount: "2",
      notConfirmedCount: "1",
      buyerSatisfactionRate: 66.66,
      valueWeightedBuyerSatisfactionRate: 88.88,
      totalPaid: "5750000",
      totalRefunded: "50000",
      averageFulfillmentSeconds: 200,
      fulfillmentSampleSize: "2",
      safeBlock: "123",
    });
    expect(result.recentPurchases[0]).toMatchObject({
      amount: "1000000",
      outcomeId: "register-domain",
    });
    expect(result.recentPurchases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        txHash: TX_HASH,
        buyerAgentId: "7",
        buyerName: "Test Buyer",
      }),
    ]));
  });

  it("reports unavailable samples without inventing a score", () => {
    const result = presentReputation([], 456n);
    expect(result.completionRate).toBeNull();
    expect(result.buyerSatisfactionRate).toBeNull();
    expect(result.valueWeightedBuyerSatisfactionRate).toBeNull();
    expect(result.averageFulfillmentSeconds).toBeNull();
    expect(result.fulfillmentSampleSize).toBe("0");
    expect(result.recentPurchases).toEqual([]);
  });

  it("joins settlement receipts and ERC-8004 buyer identity in one cached snapshot", async () => {
    const getBlock = vi.fn(async () => ({ number: 123n }));
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getRecordCount") return 1n;
      if (functionName === "recordKeys") return ORDER_KEY;
      if (functionName === "getRecord") return {
        ...record({ outcomeRecorded: true, outcomeAttestationDelay: 90n }),
        providerAgentId: 1n,
        authorizationKey: `0x${"66".repeat(32)}`,
        providerOwner: ADDRESS,
        providerAgentWallet: ADDRESS,
        providerPayee: ADDRESS,
        canonicalToken: ADDRESS,
        providerIdentitySnapshotHash: `0x${"77".repeat(32)}`,
        listingManifestHash: MANIFEST_HASH,
        releaseEvidenceHash: `0x${"88".repeat(32)}`,
        outcomeTimestamp: 1_700_000_090n,
        confirmationTimestamp: 0n,
        confirmationTransitions: 0,
        currentConfirmationUid: `0x${"00".repeat(32)}`,
      };
      if (functionName === "refundedAmount") return 0n;
      if (functionName === "resolve") return [7n, true] as const;
      if (functionName === "tokenURI") {
        return `data:application/json;base64,${Buffer.from(JSON.stringify({ name: "Test Buyer" })).toString("base64")}`;
      }
      throw new Error(`unexpected read ${functionName}`);
    });
    const multicall = vi.fn(async ({ contracts, allowFailure }: {
      contracts: Array<{ functionName: string; args?: readonly unknown[] }>;
      allowFailure?: boolean;
    }) => {
      const results = await Promise.all(contracts.map((contract) => readContract(contract)));
      return allowFailure === false
        ? results
        : results.map((result) => ({ status: "success", result }));
    });
    const fallback = { getBlock: vi.fn(), readContract: vi.fn(), multicall: vi.fn() };
    const query = vi.fn(async () => ({
      rows: [{ order_key: ORDER_KEY, settlement_tx_hash: TX_HASH }],
    }));
    const reader = new DirectReputationReader({
      evidenceRpcUrls: ["https://rpc.example", "https://fallback.example"],
      reputationContract: ADDRESS,
    } as unknown as StandardRailConfig, baseSepolia, { query } as never, {
      agentIndex: ADDRESS,
      identityRegistry: ADDRESS,
    });
    Object.assign(reader as unknown as { clients: unknown[] }, {
      clients: [
        { host: "rpc.example", client: { getBlock, readContract, multicall } },
        { host: "fallback.example", client: fallback },
      ],
    });
    const outcomes = [{
      providerAgentId: "1",
      serviceId: SERVICE_ID,
      outcomeId: "register-domain",
      listingManifestHash: MANIFEST_HASH,
    }];

    const first = await reader.forOutcomes(outcomes);
    await reader.forOutcomes(outcomes);

    expect(first.services.get(SERVICE_ID)?.recentPurchases[0]).toMatchObject({
      txHash: TX_HASH,
      payer: PAYER,
      buyerAgentId: "7",
      buyerName: "Test Buyer",
      outcomeId: "register-domain",
    });
    expect(first.services.get(SERVICE_ID)?.averageFulfillmentSeconds).toBe(90);
    expect(getBlock).toHaveBeenCalledOnce();
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "safe" });
    expect(query).toHaveBeenCalledOnce();

    reader.invalidate();
    const during = await reader.forOutcomes(outcomes);
    expect(during).toBe(first);
    await reader.settled();
    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(reader.refreshedAt()).toBeInstanceOf(Date);
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
    expect(fallback.multicall).not.toHaveBeenCalled();
  });

  it("serves the last snapshot while refreshing in the background and keeps it through a failed refresh", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      const reader = new DirectReputationReader({
        evidenceRpcUrls: ["https://rpc.example"],
        reputationContract: ADDRESS,
        chainProjectionRefreshMs: 1_000,
      } as unknown as StandardRailConfig, baseSepolia, { query: vi.fn() } as never, {
        agentIndex: ADDRESS,
        identityRegistry: ADDRESS,
      });
      const snapshot = (safeBlock: string) => ({ providers: new Map(), services: new Map(), safeBlock });
      const snapshots = [snapshot("1"), snapshot("2"), snapshot("3")];
      const readOutcomes = vi.fn()
        .mockResolvedValueOnce(snapshots[0])
        .mockRejectedValueOnce(new Error("rpc offline"))
        .mockResolvedValueOnce(snapshots[1])
        .mockResolvedValueOnce(snapshots[2]);
      Object.assign(reader as unknown as { readOutcomes: unknown }, { readOutcomes });
      const outcomes = [{
        providerAgentId: "1",
        serviceId: SERVICE_ID,
        outcomeId: "register-domain",
        listingManifestHash: MANIFEST_HASH,
      }];

      // Only the first read waits; a fresh snapshot is served without a refresh.
      expect(reader.refreshedAt()).toBeNull();
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[0]);
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[0]);
      expect(readOutcomes).toHaveBeenCalledTimes(1);

      // A finalized write invalidates: the snapshot stays served while the refresh fails.
      reader.invalidate();
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[0]);
      await reader.settled();
      expect(readOutcomes).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);

      // Still stale, so the next read refreshes again and recovers.
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[0]);
      await reader.settled();
      expect(readOutcomes).toHaveBeenCalledTimes(3);
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[1]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith("public reputation projection refresh recovered");

      // The schedule refreshes without any request until stopped.
      reader.start();
      await vi.advanceTimersByTimeAsync(1_000);
      await reader.settled();
      expect(readOutcomes).toHaveBeenCalledTimes(4);
      expect(await reader.forOutcomes(outcomes)).toBe(snapshots[2]);
      reader.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(readOutcomes).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
