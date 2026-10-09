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
    serviceName: "Domain Management",
    skillName: "Register Domain",
    outcome: 0,
    confirmation: 0,
    outcomeAttestationDelay: 0n,
    outcomeRecorded: false,
    reputationEligible: true,
    recovered: false,
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
    ], 123n, true);

    expect(result).toMatchObject({
      transactionCount: "4",
      completedCount: "2",
      failedCount: "1",
      recoveredCount: "0",
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
    const result = presentReputation([], 456n, false);
    expect(result.completionRate).toBeNull();
    expect(result.buyerSatisfactionRate).toBeNull();
    expect(result.valueWeightedBuyerSatisfactionRate).toBeNull();
    expect(result.averageFulfillmentSeconds).toBeNull();
    expect(result.fulfillmentSampleSize).toBe("0");
    expect(result.recoveredCount).toBeNull();
    expect(result.recentPurchases).toEqual([]);
    // Where recoveries are recorded, nothing to count is a real zero.
    expect(presentReputation([], 456n, true).recoveredCount).toBe("0");
  });

  it("counts recovered Failed orders beside the outcome figures without changing them", () => {
    const key = (byte: string) => `0x${byte.repeat(32)}` as Hex;
    const records = [
      record({ orderKey: key("21"), outcomeRecorded: true, outcome: 0, outcomeAttestationDelay: 100n }),
      record({ orderKey: key("22"), outcomeRecorded: true, outcome: 1, recovered: true }),
      record({ orderKey: key("23"), outcomeRecorded: true, outcome: 1, recovered: false }),
      // Only a Failed, eligible, recorded outcome can be counted as recovered.
      record({ orderKey: key("24"), outcomeRecorded: true, outcome: 2, recovered: true }),
      record({ orderKey: key("25"), outcomeRecorded: false, outcome: 1, recovered: true }),
      record({ orderKey: key("26"), outcomeRecorded: true, outcome: 1, recovered: true, reputationEligible: false }),
    ];

    const recorded = presentReputation(records, 9n, true);
    expect(recorded).toMatchObject({
      transactionCount: "5",
      completedCount: "1",
      failedCount: "2",
      canceledCount: "1",
      recoveredCount: "1",
      completionSampleSize: "4",
      completionRate: 25,
      averageFulfillmentSeconds: 100,
      fulfillmentSampleSize: "1",
    });
    // Recovery is reported beside the Failed outcome: every other figure is
    // what the same records give where recoveries are not recorded.
    const unrecorded = presentReputation(records, 9n, false);
    expect(unrecorded.recoveredCount).toBeNull();
    expect({ ...recorded, recoveredCount: null }).toEqual(unrecorded);

    // One counted Failed order whose recovery could not be read makes the
    // figure unknown rather than an undercount.
    const unreadable = presentReputation([
      ...records,
      record({ orderKey: key("27"), outcomeRecorded: true, outcome: 1, recovered: null }),
    ], 9n, true);
    expect(unreadable.recoveredCount).toBeNull();
    expect(unreadable.failedCount).toBe("3");
    // An unreadable recovery on a record that is not counted changes nothing.
    expect(presentReputation([
      ...records,
      record({ orderKey: key("28"), outcomeRecorded: true, outcome: 0, recovered: null }),
    ], 9n, true).recoveredCount).toBe("1");
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

  it.each([
    { label: "saved checkout names", saved: true, names: true, expected: "form-entity" },
    { label: "legacy order without names", saved: true, names: false, expected: "form-entity" },
    { label: "missing order", saved: false, names: false, expected: "unknown" },
    { label: "mismatched order manifest", saved: true, names: true, mismatch: "listing_manifest_hash", expected: "unknown" },
    { label: "mismatched order service", saved: true, names: true, mismatch: "service_id", expected: "unknown" },
    { label: "mismatched order provider", saved: true, names: true, mismatch: "provider_agent_id", expected: "unknown" },
    { label: "database unavailable", saved: false, names: false, offline: true, expected: "unknown" },
  ])("resolves retired manifests using $label", async ({ saved, names, mismatch, offline, expected }) => {
    const savedOrder = {
      order_key: ORDER_KEY, settlement_tx_hash: TX_HASH, provider_agent_id: "1",
      service_id: SERVICE_ID, listing_manifest_hash: MANIFEST_HASH, outcome_id: "form-entity",
      service_name: names ? "Entity Formation" : null,
      skill_name: names ? "Form Entity" : null,
      ...(mismatch ? { [mismatch]: "different" } : {}),
    };
    const query = vi.fn(async () => {
      if (offline) throw new Error("database unavailable");
      return { rows: saved ? [savedOrder] : [] };
    });
    const reader = new DirectReputationReader({
      evidenceRpcUrls: ["https://rpc.example"], reputationContract: ADDRESS,
    } as unknown as StandardRailConfig, baseSepolia, { query } as never, {
      agentIndex: ADDRESS, identityRegistry: ADDRESS,
    });
    const client = {
      getBlock: async () => ({ number: 123n }),
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "getRecordCount") return 1n;
        if (functionName === "resolve") return [0n, false];
        throw new Error(`unexpected read ${functionName}`);
      },
      multicall: async ({ contracts }: { contracts: Array<{ functionName: string }> }) =>
        contracts.map(({ functionName }) => {
          if (functionName === "recordKeys") return ORDER_KEY;
          if (functionName === "getRecord") return {
            ...record(), providerAgentId: 1n, listingManifestHash: MANIFEST_HASH,
          };
          if (functionName === "refundedAmount") return 0n;
          if (functionName === "resolve") return { status: "success", result: [0n, false] };
          throw new Error(`unexpected multicall ${functionName}`);
        }),
    };
    Object.assign(reader, { clients: [{ host: "rpc.example", client }] });
    const current = ["form-entity", "renew-registered-agent"].map((outcomeId, index) => ({
      providerAgentId: "1", serviceId: SERVICE_ID, outcomeId,
      listingManifestHash: `0x${String(index + 7).repeat(64)}` as Hex,
    }));
    const snapshot = await reader.forOutcomes(current);
    const purchase = snapshot.services.get(SERVICE_ID)?.recentPurchases[0];
    expect(purchase?.outcomeId).toBe(expected);
    expect(purchase?.skillName).toBe(names && !mismatch ? "Form Entity" : "Unknown skill");
    expect(purchase?.serviceName).toBe(names && !mismatch ? "Entity Formation" : "Unknown service");
    expect(snapshot.services.get(SERVICE_ID)?.transactionCount).toBe("1");
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

// ── recovered orders on the record path ──────────────────────────────────────

const SECOND_SERVICE = `0x${"23".repeat(32)}` as Hex;
const SECOND_MANIFEST = `0x${"34".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

interface ChainOrder {
  orderKey: Hex;
  providerAgentId: bigint;
  serviceId: Hex;
  listingManifestHash: Hex;
  outcome: number;
  outcomeRecorded: boolean;
  reputationEligible: boolean;
  outcomeAttestationDelay: bigint;
  /** What getRecovery answers for this order key, or the error its read fails with. */
  recoveredAt: bigint | Error;
}

const orderKey = (byte: string) => `0x${byte.repeat(32)}` as Hex;

function chainOrder(byte: string, overrides: Partial<ChainOrder> = {}): ChainOrder {
  return {
    orderKey: orderKey(byte),
    providerAgentId: 1n,
    serviceId: SERVICE_ID,
    listingManifestHash: MANIFEST_HASH,
    outcome: 0,
    outcomeRecorded: true,
    reputationEligible: true,
    outcomeAttestationDelay: 0n,
    recoveredAt: 0n,
    ...overrides,
  };
}

const SECOND_PROVIDER = {
  providerAgentId: 2n,
  serviceId: SECOND_SERVICE,
  listingManifestHash: SECOND_MANIFEST,
} as const;

const RECOVERY_OUTCOMES = [
  { providerAgentId: "1", serviceId: SERVICE_ID, outcomeId: "register-domain", listingManifestHash: MANIFEST_HASH },
  { providerAgentId: "2", serviceId: SECOND_SERVICE, outcomeId: "form-entity", listingManifestHash: SECOND_MANIFEST },
];

// Completed, Failed and recovered, Failed, Canceled and pending orders of one
// provider, an ineligible Failed order the chain claims is recovered, and a
// second provider with one recovered Failed order.
function mixedOrders(): ChainOrder[] {
  return [
    chainOrder("a1", { outcome: 0, outcomeAttestationDelay: 100n }),
    chainOrder("a2", { outcome: 1, recoveredAt: 1_700_000_500n }),
    chainOrder("a3", { outcome: 1 }),
    chainOrder("a4", { outcome: 2 }),
    chainOrder("a5", { outcomeRecorded: false }),
    chainOrder("a6", { outcome: 1, reputationEligible: false, recoveredAt: 1_700_000_550n }),
    chainOrder("b1", { ...SECOND_PROVIDER, outcome: 1, recoveredAt: 1_700_000_600n }),
    chainOrder("b2", { ...SECOND_PROVIDER, outcome: 0, outcomeAttestationDelay: 50n }),
  ];
}

function recoveryChain(initial: {
  orders: ChainOrder[];
  version: unknown;
  recoveryBatch?: "reject";
}) {
  const state: {
    block: bigint;
    orders: ChainOrder[];
    version: unknown;
    recoveryBatch?: "reject";
  } = { block: 123n, ...initial };
  const reads: Array<{ functionName: string; blockNumber: unknown; args?: readonly unknown[] }> = [];
  const answer = (functionName: string, args: readonly unknown[] = []): unknown => {
    const order = () => state.orders.find((item) => item.orderKey === args[0])!;
    switch (functionName) {
      case "getRecordCount": return BigInt(state.orders.length);
      case "version":
        if (state.version instanceof Error) throw state.version;
        return state.version;
      case "recordKeys": return state.orders[Number(args[0])]!.orderKey;
      case "getRecord": {
        const item = order();
        return {
          orderKey: item.orderKey,
          providerAgentId: item.providerAgentId,
          serviceId: item.serviceId,
          listingManifestHash: item.listingManifestHash,
          payer: PAYER,
          grossAmount: 1_000_000n,
          paidAt: 1_700_000_000n,
          outcome: item.outcome,
          confirmation: 0,
          outcomeAttestationDelay: item.outcomeAttestationDelay,
          outcomeRecorded: item.outcomeRecorded,
          reputationEligible: item.reputationEligible,
        };
      }
      case "refundedAmount": return 0n;
      case "getRecovery": {
        const { recoveredAt } = order();
        if (recoveredAt instanceof Error) throw recoveredAt;
        return [recoveredAt, recoveredAt === 0n ? ZERO_HASH : orderKey("ee"), ZERO_HASH];
      }
      case "resolve": return [0n, false];
      default: throw new Error(`unexpected read ${functionName}`);
    }
  };
  const client = {
    getBlock: vi.fn(async () => ({ number: state.block })),
    readContract: vi.fn(async ({ functionName, args, blockNumber }: {
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      reads.push({ functionName, blockNumber, args });
      return answer(functionName, args);
    }),
    multicall: vi.fn(async ({ contracts, allowFailure, blockNumber }: {
      contracts: Array<{ functionName: string; args?: readonly unknown[] }>;
      allowFailure?: boolean;
      blockNumber?: bigint;
    }) => {
      if (
        state.recoveryBatch === "reject" &&
        contracts.some(({ functionName }) => functionName === "getRecovery")
      ) throw new Error("rpc offline");
      return contracts.map(({ functionName, args }) => {
        reads.push({ functionName, blockNumber, args });
        try {
          const result = answer(functionName, args);
          return allowFailure === false ? result : { status: "success", result };
        } catch (error) {
          if (allowFailure === false) throw error;
          return { status: "failure", error };
        }
      });
    }),
  };
  const reader = new DirectReputationReader({
    evidenceRpcUrls: ["https://rpc.example"],
    reputationContract: ADDRESS,
  } as unknown as StandardRailConfig, baseSepolia, { query: vi.fn(async () => ({ rows: [] })) } as never, {
    agentIndex: ADDRESS,
    identityRegistry: ADDRESS,
  });
  Object.assign(reader, { clients: [{ host: "rpc.example", client }] });
  return { reader, state, reads };
}

describe("recovered orders on the record path", () => {
  it("counts recovered Failed orders per provider and service at the block of the walk", async () => {
    const { reader, reads } = recoveryChain({ orders: mixedOrders(), version: "2.2.0" });

    const snapshot = await reader.forOutcomes(RECOVERY_OUTCOMES);

    for (const figures of [snapshot.providers.get("1"), snapshot.services.get(SERVICE_ID)]) {
      expect(figures).toMatchObject({
        transactionCount: "5",
        completedCount: "1",
        failedCount: "2",
        canceledCount: "1",
        recoveredCount: "1",
        completionSampleSize: "4",
        completionRate: 25,
        averageFulfillmentSeconds: 100,
        fulfillmentSampleSize: "1",
        safeBlock: "123",
      });
    }
    for (const figures of [snapshot.providers.get("2"), snapshot.services.get(SECOND_SERVICE)]) {
      expect(figures).toMatchObject({
        transactionCount: "2",
        completedCount: "1",
        failedCount: "1",
        recoveredCount: "1",
        completionRate: 50,
        averageFulfillmentSeconds: 50,
      });
    }
    // Only eligible Failed records are read, in one batch with the walk's
    // block, and the version that admits them is read at that block too.
    expect(reads.filter(({ functionName }) => functionName === "getRecovery").map(({ args }) => args?.[0]))
      .toEqual(["a2", "a3", "b1"].map(orderKey));
    expect(reads.filter(({ functionName }) => functionName === "version")).toHaveLength(1);
    expect(new Set(reads.map(({ blockNumber }) => blockNumber))).toEqual(new Set([123n]));
  });

  it("reports no recovered count where the block's contract predates recoveries", async () => {
    const recorded = await recoveryChain({ orders: mixedOrders(), version: "2.2.0" })
      .reader.forOutcomes(RECOVERY_OUTCOMES);
    const { reader, reads } = recoveryChain({ orders: mixedOrders(), version: "2.1.0" });

    const snapshot = await reader.forOutcomes(RECOVERY_OUTCOMES);

    for (const [provider, figures] of snapshot.providers) {
      expect(figures).toEqual({ ...recorded.providers.get(provider)!, recoveredCount: null });
    }
    for (const [service, figures] of snapshot.services) {
      expect(figures).toEqual({ ...recorded.services.get(service)!, recoveredCount: null });
    }
    expect(reads.some(({ functionName }) => functionName === "getRecovery")).toBe(false);
  });

  it.each([
    { label: "the version read fails", version: new Error("rpc offline"), expected: { "1": null, "2": null } },
    { label: "the version is malformed", version: "2.2", expected: { "1": null, "2": null } },
    { label: "the recovery batch fails", version: "2.2.0", recoveryBatch: "reject" as const, expected: { "1": null, "2": null } },
    { label: "one order's recovery read fails", version: "2.2.0", unreadable: "b1", expected: { "1": "1", "2": null } },
  ])("keeps every other figure when $label", async ({ version, recoveryBatch, unreadable, expected }) => {
    const recorded = await recoveryChain({ orders: mixedOrders(), version: "2.2.0" })
      .reader.forOutcomes(RECOVERY_OUTCOMES);
    const orders = mixedOrders().map((order) => unreadable && order.orderKey === orderKey(unreadable)
      ? { ...order, recoveredAt: new Error("execution reverted") }
      : order);
    const { reader } = recoveryChain({ orders, version, recoveryBatch });

    const snapshot = await reader.forOutcomes(RECOVERY_OUTCOMES);

    expect(reader.refreshedAt()).toBeInstanceOf(Date);
    for (const [provider, service] of [["1", SERVICE_ID], ["2", SECOND_SERVICE]] as const) {
      expect(snapshot.providers.get(provider))
        .toEqual({ ...recorded.providers.get(provider)!, recoveredCount: expected[provider] });
      expect(snapshot.services.get(service))
        .toEqual({ ...recorded.services.get(service)!, recoveredCount: expected[provider] });
    }
  });

  it("still refreshes every other figure when only the recovery reads fail", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { reader, state } = recoveryChain({ orders: mixedOrders(), version: "2.2.0" });
      const first = await reader.forOutcomes(RECOVERY_OUTCOMES);
      expect(first.providers.get("1")).toMatchObject({ completedCount: "1", recoveredCount: "1" });

      // A new completed order lands while the recovery reads start failing.
      state.block = 124n;
      state.orders = [...mixedOrders(), chainOrder("a7", { outcome: 0, outcomeAttestationDelay: 300n })];
      state.version = new Error("rpc offline");
      reader.invalidate();
      await reader.settled();

      const refreshed = await reader.forOutcomes(RECOVERY_OUTCOMES);
      expect(refreshed).not.toBe(first);
      expect(refreshed.safeBlock).toBe("124");
      expect(refreshed.providers.get("1")).toMatchObject({
        transactionCount: "6",
        completedCount: "2",
        failedCount: "2",
        recoveredCount: null,
        averageFulfillmentSeconds: 200,
        safeBlock: "124",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
