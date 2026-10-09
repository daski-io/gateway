import { describe, expect, it, vi } from "vitest";
import { baseSepolia } from "viem/chains";
import type { Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { WalletAuthorizationTransport } from "../src/standardRail/types.js";
import { StandardWalletQueries } from "../src/standardRail/walletQueries.js";
import type { StandardWalletStore } from "../src/standardRail/walletStore.js";

describe("wallet reputation queries", () => {
  it("returns the buyer's on-chain value totals with their feedback counts", async () => {
    const payer = "0x2222222222222222222222222222222222222222";
    // consume() is the authorization boundary: it returns the payer it proved,
    // and the query must use that value rather than the caller's input.
    const consume = vi.fn(async (args: { payer: string }) => ({
      payer: args.payer.toLowerCase(),
      authorizationHash: `0x${"ab".repeat(32)}`,
    }));
    const getBlock = vi.fn(async () => ({ number: 123n }));
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getBuyerStats") return [4n, 3n, 1n];
      if (functionName === "totalPaidByPayer") return 12_000_000n;
      if (functionName === "refundedAmountByPayer") return 2_000_000n;
      throw new Error(`unexpected contract read: ${functionName}`);
    });
    const fallback = { getBlock: vi.fn(), readContract: vi.fn() };
    const queries = new StandardWalletQueries(
      {} as Pool,
      { consume } as unknown as StandardWalletStore,
      {
        evidenceRpcUrls: ["https://rpc.example", "https://fallback.example"],
        reputationContract: "0x1111111111111111111111111111111111111111",
        finalityTag: "finalized",
      } as unknown as StandardRailConfig,
      baseSepolia,
    );
    Object.assign(queries as unknown as { clients: unknown[] }, {
      clients: [
        { host: "rpc.example", client: { getBlock, readContract } },
        { host: "fallback.example", client: fallback },
      ],
    });

    await expect(queries.getReputation({
      payer,
      authorization: {} as WalletAuthorizationTransport,
    })).resolves.toEqual({
      eligibleTransactionCount: "4",
      confirmedCount: "3",
      notConfirmedCount: "1",
      totalPaid: "12000000",
      totalRefunded: "2000000",
      safeBlock: "123",
    });
    expect(consume).toHaveBeenCalledOnce();
    expect(consume.mock.calls[0]?.[0]).toMatchObject({ payer });
    // The aggregate is read at the configured finality tag, like the order history.
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
    expect(readContract).toHaveBeenCalledTimes(3);
  });
});

// ── recoveries on the payer's order history ──────────────────────────────────

const HISTORY_PAYER = "0x2222222222222222222222222222222222222222";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const keyOf = (index: number) => `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;

interface HistoryRecord {
  registered: boolean;
  outcome: number;
  outcomeRecorded: boolean;
  /** What getRecovery answers for the order, or the error its read fails with. */
  recoveredAt?: bigint | Error;
}

// A recovered Failed order, a Failed order, a Completed order, an order not
// yet registered on chain, and a Failed order whose recovery read fails.
const HISTORY: HistoryRecord[] = [
  { registered: true, outcome: 1, outcomeRecorded: true, recoveredAt: 1_700_000_900n },
  { registered: true, outcome: 1, outcomeRecorded: true, recoveredAt: 0n },
  { registered: true, outcome: 0, outcomeRecorded: true },
  { registered: false, outcome: 0, outcomeRecorded: false },
  { registered: true, outcome: 1, outcomeRecorded: true, recoveredAt: new Error("rpc offline") },
];

function orderHistory(version: unknown) {
  const rows = HISTORY.map((_, index) => ({
    order_id: `order-${index}`,
    order_handle: `handle-${index}`,
    intent_id: `intent-${index}`,
    order_key: Buffer.alloc(32, index + 1),
    provider_agent_id: "7",
    outcome_id: "register-domain",
    state: "PROVIDER_FAILED",
    gross_amount: "1000000",
    canonical_listing: { commitment: { payload: { serviceId: `0x${"33".repeat(32)}` } } },
    registration_operation_state: "final",
    created_at: new Date("2026-10-01T00:00:00.000Z"),
    created_at_cursor: "2026-10-01 00:00:00+00",
    updated_at: new Date("2026-10-02T00:00:00.000Z"),
  }));
  const reads: Array<{ functionName: string; blockNumber: unknown; orderKey: unknown }> = [];
  const readContract = vi.fn(async ({ functionName, args, blockNumber }: {
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }) => {
    reads.push({ functionName, blockNumber, orderKey: args?.[0] });
    if (functionName === "version") {
      if (version instanceof Error) throw version;
      return version;
    }
    const index = HISTORY.findIndex((_, position) => keyOf(position) === args?.[0]);
    const record = HISTORY[index]!;
    if (functionName === "getRecord") {
      return {
        orderKey: record.registered ? keyOf(index) : ZERO_HASH,
        outcome: record.outcome,
        outcomeRecorded: record.outcomeRecorded,
        reputationEligible: true,
        confirmation: 0,
        confirmationSubmissions: 0,
      };
    }
    if (functionName === "getRecovery") {
      if (record.recoveredAt instanceof Error) throw record.recoveredAt;
      return [record.recoveredAt ?? 0n, ZERO_HASH, ZERO_HASH];
    }
    throw new Error(`unexpected contract read: ${functionName}`);
  });
  const fallback = { getBlock: vi.fn(), readContract: vi.fn() };
  const queries = new StandardWalletQueries(
    { query: vi.fn(async () => ({ rows })) } as unknown as Pool,
    {
      consume: vi.fn(async () => ({ payer: HISTORY_PAYER })),
      orderCursorBinding: vi.fn(() => ({})),
    } as unknown as StandardWalletStore,
    {
      evidenceRpcUrls: ["https://rpc.example", "https://fallback.example"],
      reputationContract: "0x1111111111111111111111111111111111111111",
      finalityTag: "finalized",
    } as unknown as StandardRailConfig,
    baseSepolia,
  );
  Object.assign(queries as unknown as { clients: unknown[] }, {
    clients: [
      { host: "rpc.example", client: { getBlock: vi.fn(async () => ({ number: 456n })), readContract } },
      { host: "fallback.example", client: fallback },
    ],
  });
  return { queries, reads, fallback };
}

function listHistory(queries: StandardWalletQueries) {
  return queries.listOrders({
    payer: HISTORY_PAYER,
    limit: 25,
    cursor: null,
    authorization: {} as WalletAuthorizationTransport,
  });
}

describe("wallet order recoveries", () => {
  it("reads each Failed order's recovery at the block of its record", async () => {
    const { queries, reads, fallback } = orderHistory("2.2.0");

    const { orders } = await listHistory(queries);

    expect(orders.map((order) => order.reputation.recovery)).toEqual([
      { recoveredAt: "1700000900" },
      { recoveredAt: null },
      { recoveredAt: null },
      { recoveredAt: null },
      null,
    ]);
    // A recovery is reported beside the Failed outcome, never instead of it.
    expect(orders.map((order) => order.reputation.providerOutcome))
      .toEqual(["Failed", "Failed", "Completed", "Pending", "Failed"]);
    // Only registered Failed orders are read, at the block of their records.
    expect(reads.filter((read) => read.functionName === "getRecovery").map((read) => read.orderKey))
      .toEqual([keyOf(0), keyOf(1), keyOf(4)]);
    expect(reads.filter((read) => read.functionName === "version")).toHaveLength(1);
    expect(new Set(reads.map((read) => read.blockNumber))).toEqual(new Set([456n]));
    expect(fallback.readContract).not.toHaveBeenCalled();
  });

  it.each([
    { label: "predates recoveries", version: "2.1.0" },
    { label: "reports a malformed version", version: "2.2.0-rc.1" },
    { label: "cannot be read", version: new Error("rpc offline") },
  ])("reports every recovery as null where the contract $label", async ({ version }) => {
    const supported = await listHistory(orderHistory("2.2.0").queries);
    const { queries, reads, fallback } = orderHistory(version);

    const history = await listHistory(queries);

    expect(history.orders.map((order) => order.reputation.recovery)).toEqual([null, null, null, null, null]);
    expect(history).toEqual({
      ...supported,
      orders: supported.orders.map((order) => ({
        ...order,
        reputation: { ...order.reputation, recovery: null },
      })),
    });
    expect(reads.some((read) => read.functionName === "getRecovery")).toBe(false);
    expect(fallback.getBlock).not.toHaveBeenCalled();
    expect(fallback.readContract).not.toHaveBeenCalled();
  });
});
