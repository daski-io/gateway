import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainEventsIndexer } from "../src/indexer/chainEvents.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const ZERO_HEX = ("0x" + "00".repeat(32)) as Hex;

function makeLog(args: {
  paymentId: bigint;
  blockNumber: bigint;
  serviceId: Hex;
  buyerAgentId: bigint;
  providerAgentId: bigint;
  amount: bigint;
  txHash: Hex;
  timestamp?: bigint;
}) {
  return {
    paymentId: args.paymentId,
    serviceRef: ZERO_HEX,
    serviceId: args.serviceId,
    buyerAgentId: args.buyerAgentId,
    providerAgentId: args.providerAgentId,
    token: "0x000000000000000000000000000000000000a003" as Hex,
    totalAmount: args.amount,
    providerAmount: args.amount,
    commission: 0n,
    blockNumber: args.blockNumber,
    blockTimestamp: args.timestamp ?? 1_700_000_000n,
    transactionHash: args.txHash,
  };
}

describe("ChainEventsIndexer", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("ingests PaymentSettled events into chain_events on first tick", async () => {
    gateway.mockChain.setBlockNumber(100n);
    gateway.mockChain.pushPaymentSettledLog(
      makeLog({
        paymentId: 1n,
        blockNumber: 100n,
        serviceId: ZERO_HEX,
        buyerAgentId: 5n,
        providerAgentId: 1n,
        amount: 5_000_000n,
        txHash: ("0x" + "aa".repeat(32)) as Hex,
      }),
    );

    const indexer = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      { initialLookbackBlocks: 1000n },
    );
    await indexer.tick();

    const rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentId).toBe(1n);
    expect(rows[0].amountAtomic).toBe(5_000_000n);
    expect(rows[0].buyerAgentId).toBe(5n);
  });

  it("advances the cursor and skips already-indexed blocks", async () => {
    gateway.mockChain.setBlockNumber(100n);
    gateway.mockChain.pushPaymentSettledLog(
      makeLog({
        paymentId: 7n,
        blockNumber: 50n,
        serviceId: ZERO_HEX,
        buyerAgentId: 5n,
        providerAgentId: 1n,
        amount: 1_000_000n,
        txHash: ("0x" + "bb".repeat(32)) as Hex,
      }),
    );

    const indexer = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      { initialLookbackBlocks: 1000n },
    );
    await indexer.tick();
    const cursor1 = await gateway.bundle.queries.getLastIndexedBlock();
    expect(cursor1).toBe(100n);

    // Second tick with no new logs and no new blocks → cursor unchanged,
    // no error.
    await indexer.tick();
    const cursor2 = await gateway.bundle.queries.getLastIndexedBlock();
    expect(cursor2).toBe(100n);
  });

  it("backfills from `head - initialLookbackBlocks` on cold start", async () => {
    gateway.mockChain.setBlockNumber(2_000_000n);
    // Event at block 1_500_500 should be captured (within 600k lookback).
    gateway.mockChain.pushPaymentSettledLog(
      makeLog({
        paymentId: 9n,
        blockNumber: 1_500_500n,
        serviceId: ZERO_HEX,
        buyerAgentId: 5n,
        providerAgentId: 1n,
        amount: 2_000_000n,
        txHash: ("0x" + "cc".repeat(32)) as Hex,
      }),
    );
    // Event at block 1_000_000 should be SKIPPED (before lookback window).
    gateway.mockChain.pushPaymentSettledLog(
      makeLog({
        paymentId: 10n,
        blockNumber: 1_000_000n,
        serviceId: ZERO_HEX,
        buyerAgentId: 5n,
        providerAgentId: 1n,
        amount: 2_000_000n,
        txHash: ("0x" + "dd".repeat(32)) as Hex,
      }),
    );

    const indexer = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      { initialLookbackBlocks: 600_000n },
    );
    await indexer.tick();

    const rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows.map((r) => r.paymentId)).toEqual([9n]);
  });

  it("paginates large block ranges", async () => {
    gateway.mockChain.setBlockNumber(10_000n);
    // Three events spread across a >2k block window.
    for (const [i, block] of [
      [1n, 8_000n],
      [2n, 9_000n],
      [3n, 9_500n],
    ] as const) {
      gateway.mockChain.pushPaymentSettledLog(
        makeLog({
          paymentId: i,
          blockNumber: block,
          serviceId: ZERO_HEX,
          buyerAgentId: 5n,
          providerAgentId: 1n,
          amount: 1_000_000n,
          txHash: ("0x" + i.toString(16).padStart(64, "0")) as Hex,
        }),
      );
    }

    const indexer = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      { initialLookbackBlocks: 5_000n, blockRangePerCall: 500n },
    );
    await indexer.tick();

    const rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows.map((r) => r.paymentId).sort((a, b) => Number(a - b))).toEqual([
      1n, 2n, 3n,
    ]);
  });

  it("refreshes outcome + confirmation + refund on subsequent ticks", async () => {
    gateway.mockChain.setBlockNumber(100n);
    gateway.mockChain.pushPaymentSettledLog(
      makeLog({
        paymentId: 42n,
        blockNumber: 100n,
        serviceId: ZERO_HEX,
        buyerAgentId: 5n,
        providerAgentId: 1n,
        amount: 1_000_000n,
        txHash: ("0x" + "ee".repeat(32)) as Hex,
      }),
    );

    const indexer = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      {
        initialLookbackBlocks: 1000n,
        // Set refresh interval to 0 so the second tick re-polls every row.
        refreshIntervalMs: 0,
      },
    );
    await indexer.tick();

    // First tick: outcome is null (mock returns null for paymentId 42).
    let rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows[0].outcomeCode).toBeNull();
    expect(rows[0].refundedAtomic).toBe(0n);

    // Now the provider attests and the buyer refunds 100k atomic.
    gateway.mockChain.setReputationRecord(42n, {
      paymentId: 42n,
      providerAgentId: 1n,
      buyerAgentId: 5n,
      serviceId: ZERO_HEX,
      outcome: "Completed",
      confirmation: "Confirmed",
      fulfillmentSeconds: 60n,
      outcomeTimestamp: 1_700_000_500n,
      confirmationTimestamp: 1_700_000_600n,
      outcomeRecorded: true,
    });
    gateway.mockChain.setPaymentRefundedAmount(42n, 100_000n);

    // Second tick triggers the refresh sweep (refreshIntervalMs=0 → all
    // rows are "stale" and get re-polled).
    await indexer.tick();

    rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows[0].outcomeCode).toBe(0); // Completed
    expect(rows[0].confirmationCode).toBe(1); // Confirmed
    expect(rows[0].fulfillmentSeconds).toBe(60);
    expect(rows[0].refundedAtomic).toBe(100_000n);
  });
});
