import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { DirectReputationReader, presentReputation } from "../src/standardRail/reputationReader.js";
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
    const query = vi.fn(async () => ({
      rows: [{ order_key: ORDER_KEY, settlement_tx_hash: TX_HASH }],
    }));
    const reader = new DirectReputationReader({
      evidenceRpcUrls: ["https://rpc.example"],
      reputationContract: ADDRESS,
    } as unknown as StandardRailConfig, baseSepolia, { query } as never, {
      agentIndex: ADDRESS,
      identityRegistry: ADDRESS,
    });
    Object.assign(reader as unknown as { client: unknown }, { client: { getBlock, readContract } });
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
  });
});
