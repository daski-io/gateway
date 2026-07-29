import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChainProjectionDescriptor,
  ChainProjectionEvent,
} from "../src/chain/eventTypes.js";
import { ChainEventsIndexer } from "../src/indexer/chainEvents.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const ZERO_HEX = `0x${"00".repeat(32)}` as Hex;

function descriptor(gateway: TestGateway): ChainProjectionDescriptor {
  const config = gateway.config;
  if (!config.reputationStorageAddress) {
    throw new Error("test gateway requires ReputationStorage");
  }
  return {
    chainId: config.chainId,
    paymentRouterAddress: config.paymentRouterAddress,
    reputationStorageAddress: config.reputationStorageAddress,
    easAddress: config.easAddress,
    confirmationSchemaUid: config.easConfirmationSchemaUid,
    startBlock: config.chainIndexerStartBlock,
  };
}

function settlement(
  paymentId: bigint,
  blockNumber: bigint,
  logIndex = 0,
): ChainProjectionEvent {
  return {
    kind: "payment_settled",
    paymentId,
    serviceRef: ZERO_HEX,
    serviceId: ZERO_HEX,
    buyerAgentId: 5n,
    providerAgentId: 1n,
    token: "0x000000000000000000000000000000000000a003",
    totalAmount: 5_000_000n,
    providerAmount: 5_000_000n,
    commission: 0n,
    blockNumber,
    blockTimestamp: 1_700_000_000n + blockNumber,
    transactionHash: `0x${paymentId.toString(16).padStart(64, "0")}` as Hex,
    transactionIndex: 0,
    logIndex,
  };
}

function eligibility(
  paymentId: bigint,
  blockNumber: bigint,
  reputationEligible = true,
  logIndex = 1,
  providerAgentId = 1n,
): ChainProjectionEvent {
  return {
    kind: "payment_recorded",
    paymentId,
    providerAgentId,
    buyerAgentId: 5n,
    serviceId: ZERO_HEX,
    reputationEligible,
    blockNumber,
    transactionIndex: 0,
    logIndex,
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
      configOverrides: {
        reputationStorageAddress: "0x000000000000000000000000000000000000a009",
      },
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  function indexer(
    options: {
      blockRangePerCall?: bigint;
      confirmationDepthBlocks?: bigint;
    } = {},
  ) {
    return new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      descriptor(gateway),
      options,
    );
  }

  it("adopts a clean descriptor and includes the exact start block beyond the old lookback", async () => {
    const state = await gateway.bundle.pool.query<{
      last_indexed_block: string | null;
      chain_id: string | null;
      start_block: string | null;
    }>(
      `SELECT last_indexed_block, chain_id, start_block
         FROM chain_indexer_state WHERE id = 1`,
    );
    expect(state.rows[0]).toEqual({
      last_indexed_block: null,
      chain_id: "84532",
      start_block: "0",
    });
    gateway.mockChain.setBlockNumber(1_500_001n);
    gateway.mockChain.pushChainProjectionEvent(settlement(1n, 0n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(1n, 0n));
    gateway.mockChain.pushChainProjectionEvent(settlement(1n, 0n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(1n, 0n));

    const worker = indexer({
      confirmationDepthBlocks: 0n,
      blockRangePerCall: 2_000_000n,
    });
    await worker.tick();

    const rows = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentId: 1n,
      amountAtomic: 5_000_000n,
      buyerAgentId: 5n,
      reputationEligible: true,
    });
    expect(worker.status().lastIndexedBlock).toBe(1_500_001n);
    await worker.tick();
    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(1);
  });

  it("keeps ineligible settlements out of public activity", async () => {
    gateway.mockChain.setBlockNumber(20n);
    gateway.mockChain.pushChainProjectionEvent(settlement(2n, 10n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(2n, 11n, false));

    await indexer({ confirmationDepthBlocks: 0n }).tick();

    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(0);
    const stored = await gateway.bundle.pool.query<{
      reputation_eligible: boolean;
    }>("SELECT reputation_eligible FROM chain_events WHERE payment_id = 2");
    expect(stored.rows[0]?.reputation_eligible).toBe(false);
  });

  it("projects outcome, confirmation, revocation, and monotonic refunds", async () => {
    const outcomeUid = `0x${"ab".repeat(32)}` as Hex;
    const confirmationUid = `0x${"cd".repeat(32)}` as Hex;
    const base = [settlement(42n, 10n), eligibility(42n, 10n)];
    const enrichments: ChainProjectionEvent[] = [
      {
        kind: "outcome_recorded",
        paymentId: 42n,
        providerAgentId: 1n,
        buyerAgentId: 5n,
        serviceId: ZERO_HEX,
        outcomeCode: 0,
        fulfillmentSeconds: 60n,
        attestationUid: outcomeUid,
        blockNumber: 11n,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        kind: "confirmation_submitted",
        paymentId: 42n,
        providerAgentId: 1n,
        buyerAgentId: 5n,
        serviceId: ZERO_HEX,
        confirmationCode: 1,
        attestationUid: confirmationUid,
        blockNumber: 12n,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        kind: "refunded",
        paymentId: 42n,
        cumulativeRefunded: 100_000n,
        blockNumber: 13n,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        kind: "refunded",
        paymentId: 42n,
        cumulativeRefunded: 50_000n,
        blockNumber: 14n,
        transactionIndex: 0,
        logIndex: 0,
      },
      {
        kind: "confirmation_revoked",
        attestationUid: `0x${"ef".repeat(32)}`,
        blockNumber: 14n,
        transactionIndex: 0,
        logIndex: 1,
      },
    ];
    for (const event of [...base, ...enrichments]) {
      gateway.mockChain.pushChainProjectionEvent(event);
    }
    gateway.mockChain.setBlockNumber(14n);

    const worker = indexer({ confirmationDepthBlocks: 0n });
    await worker.tick();

    let [row] = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(row).toMatchObject({
      paymentId: 42n,
      outcomeCode: 0,
      fulfillmentSeconds: 60,
      confirmationCode: 1,
      confirmationAttestationUid: confirmationUid,
      refundedAtomic: 100_000n,
    });

    gateway.mockChain.pushChainProjectionEvent({
      kind: "confirmation_revoked",
      attestationUid: confirmationUid,
      blockNumber: 15n,
      transactionIndex: 0,
      logIndex: 0,
    });
    gateway.mockChain.setBlockNumber(15n);
    await worker.tick();
    [row] = await gateway.bundle.queries.listRecentChainActivity(10);
    expect(row).toMatchObject({
      confirmationCode: 0,
      confirmationAttestationUid: null,
    });
  });

  it("rolls back the page and enters a terminal state for orphan enrichment", async () => {
    gateway.mockChain.setBlockNumber(10n);
    gateway.mockChain.pushChainProjectionEvent(settlement(7n, 5n));
    gateway.mockChain.pushChainProjectionEvent(
      eligibility(999n, 6n, true, 1, 2n),
    );
    const worker = indexer({ confirmationDepthBlocks: 0n });

    await worker.tick();

    expect(worker.status()).toMatchObject({
      terminal: true,
      lastIndexedBlock: null,
      lastFailure: { category: "projection_integrity" },
    });
    const stored = await gateway.bundle.pool.query(
      "SELECT payment_id FROM chain_events",
    );
    expect(stored.rows).toHaveLength(0);
  });

  it("rejects a stored projection descriptor mismatch", async () => {
    const worker = new ChainEventsIndexer(
      gateway.mockChain,
      gateway.bundle.queries,
      { ...descriptor(gateway), startBlock: 1n },
    );

    await expect(worker.initialize()).rejects.toThrow(
      "stored chain projection descriptor conflicts",
    );
  });

  it("rejects a partial stored projection descriptor", async () => {
    await gateway.bundle.pool.query(
      "UPDATE chain_indexer_state SET confirmation_schema_uid = NULL WHERE id = 1",
    );
    const worker = indexer();

    await expect(worker.initialize()).rejects.toThrow(
      "stored chain projection descriptor conflicts",
    );
  });

  it("waits for confirmation depth and advances pages atomically", async () => {
    gateway.mockChain.setBlockNumber(100n);
    gateway.mockChain.pushChainProjectionEvent(settlement(50n, 100n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(50n, 100n));
    const worker = indexer({
      blockRangePerCall: 25n,
      confirmationDepthBlocks: 12n,
    });

    await worker.tick();
    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(0);
    expect(worker.status().lastIndexedBlock).toBe(88n);

    gateway.mockChain.setBlockNumber(112n);
    await worker.tick();
    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(1);
    expect(worker.status().lastIndexedBlock).toBe(100n);
  });

  it("serializes projection pages across replicas", async () => {
    gateway.mockChain.setBlockNumber(10n);
    gateway.mockChain.pushChainProjectionEvent(settlement(61n, 5n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(61n, 5n));
    const first = indexer({ confirmationDepthBlocks: 0n });
    const second = indexer({ confirmationDepthBlocks: 0n });

    await Promise.all([first.tick(), second.tick()]);
    await Promise.all([first.tick(), second.tick()]);

    expect(first.status().terminal).toBe(false);
    expect(second.status().terminal).toBe(false);
    expect(first.isReady()).toBe(true);
    expect(second.isReady()).toBe(true);
    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(1);
  });

  it("fails over to another replica from the shared cursor", async () => {
    gateway.mockChain.setBlockNumber(5n);
    gateway.mockChain.pushChainProjectionEvent(settlement(71n, 5n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(71n, 5n));
    const first = indexer({ confirmationDepthBlocks: 0n });
    const second = indexer({ confirmationDepthBlocks: 0n });

    await first.tick();
    await first.stopAndDrain();
    gateway.mockChain.setBlockNumber(6n);
    gateway.mockChain.pushChainProjectionEvent(settlement(72n, 6n));
    gateway.mockChain.pushChainProjectionEvent(eligibility(72n, 6n));
    await second.tick();

    expect(second.status()).toMatchObject({
      terminal: false,
      lastIndexedBlock: 6n,
    });
    expect(
      await gateway.bundle.queries.listRecentChainActivity(10),
    ).toHaveLength(2);
  });

  it("shares terminal projection failures with follower replicas", async () => {
    gateway.mockChain.setBlockNumber(10n);
    gateway.mockChain.pushChainProjectionEvent(
      eligibility(999n, 6n, true, 1, 2n),
    );
    const leader = indexer({ confirmationDepthBlocks: 0n });
    const follower = indexer({ confirmationDepthBlocks: 0n });

    await leader.tick();
    await follower.tick();

    expect(leader.status()).toMatchObject({
      terminal: true,
      lastFailure: { category: "projection_integrity" },
    });
    expect(follower.status()).toMatchObject({
      terminal: true,
      lastFailure: { category: "projection_integrity" },
    });
  });
});
