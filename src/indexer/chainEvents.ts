import type { ChainReader, PaymentSettledEventLog } from "../chain/reader.js";
import type { Queries } from "../db/queries.js";

/**
 * Chain-events indexer. Polls `PaymentRouter.PaymentSettled` events in
 * small block windows, enriches each new paymentId with on-chain
 * `getRecord` + `refundedAmount`, and UPSERTs into the `chain_events`
 * mirror table. Powers `/public/v1/activity` and the per-service
 * recentPurchases list — both read from chain_events with a LEFT JOIN
 * onto `payment_challenges` for the rich enrichment (skillId, original
 * a2a URL, etc.) that the gateway captures at challenge-issue time.
 *
 * Two responsibilities, one loop:
 *   1. **Forward poll**: every tick, scan from `last_indexed_block + 1`
 *      to the confirmed head, paginated under `BLOCK_RANGE_PER_CALL` so even
 *      conservative RPC providers (10k-block caps) accept the request.
 *      Sets `last_indexed_block` after each successful page.
 *   2. **Refresh sweep**: also revisits recent / pending rows whose
 *      confirmation or outcome may still arrive (per-row
 *      `last_refreshed_at` timestamp throttles re-reads to once per
 *      `REFRESH_INTERVAL_MS`).
 *
 * Bootstrap behaviour: on first run, `last_indexed_block` is 0. The
 * indexer initializes to `currentHead - INITIAL_LOOKBACK_BLOCKS` so we
 * don't scan all of Base history. Conservative window covers any
 * realistic contract-deploy date for the current Daski stack.
 *
 * Reorg exposure is bounded by a confirmation-depth delay (12 blocks by
 * default). UPSERT keyed by paymentId makes duplicate fetches safe; a
 * reorg deeper than the configured confirmation depth still requires
 * operator reconciliation.
 */
export class ChainEventsIndexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: { message: string; at: Date } | null = null;
  private lastSuccessAt: Date | null = null;

  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly opts: {
      /** How often the loop ticks (ms). Default 5s — Base block time is ~2s. */
      pollIntervalMs?: number;
      /** Max blocks per getLogs call. RPC-dependent; 2000 is conservative. */
      blockRangePerCall?: bigint;
      /** Blocks kept behind the RPC head before indexing. Default 12. */
      confirmationDepthBlocks?: bigint;
      /** Initial backfill on cold start: head - this. Default 1_000_000 (~23d on Base). */
      initialLookbackBlocks?: bigint;
      /** Refresh interval for pending rows (ms). Default 60s. */
      refreshIntervalMs?: number;
      /** How many pending rows to refresh per tick. Default 20. */
      refreshBatchSize?: number;
    } = {},
  ) {}

  /** Begin the polling loop. No-op if already started. */
  start(): void {
    if (this.timer != null) return;
    const interval = this.opts.pollIntervalMs ?? 5_000;
    // Kick once immediately so first /activity request after boot already
    // has data; subsequent ticks fire on the interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  /** Stop the polling loop. Safe to call multiple times. */
  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One-shot tick. Exposed so tests can drive the loop deterministically. */
  async tick(): Promise<void> {
    if (this.running) return; // skip if previous tick still running
    this.running = true;
    try {
      await this.poll();
      await this.refreshPending();
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (err) {
      this.lastError = {
        message: err instanceof Error ? err.message : String(err),
        at: new Date(),
      };
    } finally {
      this.running = false;
    }
  }

  /** Health/diagnostic snapshot. */
  status(): {
    lastIndexedBlock: bigint | null;
    lastSuccessAt: Date | null;
    lastError: { message: string; at: Date } | null;
  } {
    return {
      lastIndexedBlock: this.cachedCursor,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private cachedCursor: bigint | null = null;

  private async poll(): Promise<void> {
    const head = await this.reader.getBlockNumber();
    const confirmationDepth = this.opts.confirmationDepthBlocks ?? 12n;
    const confirmedHead =
      head > confirmationDepth ? head - confirmationDepth : 0n;
    const cursor = await this.getOrInitCursor(confirmedHead);
    if (cursor >= confirmedHead) return;

    const rangePerCall =
      this.opts.blockRangePerCall ?? 2000n;
    let fromBlock = cursor + 1n;

    while (fromBlock <= confirmedHead) {
      const toBlock =
        fromBlock + rangePerCall - 1n > confirmedHead
          ? confirmedHead
          : fromBlock + rangePerCall - 1n;
      const events = await this.reader.getPaymentSettledEvents(
        fromBlock,
        toBlock,
      );
      if (events.length > 0) {
        await this.ingest(events);
      }
      await this.queries.setLastIndexedBlock(toBlock);
      this.cachedCursor = toBlock;
      fromBlock = toBlock + 1n;
    }
  }

  /**
   * Initialize the cursor on first run: if it's 0, set to
   * `head - initialLookbackBlocks` so we don't scan all of Base
   * history. Returns the cursor value to use.
   */
  private async getOrInitCursor(head: bigint): Promise<bigint> {
    const stored = await this.queries.getLastIndexedBlock();
    if (stored > 0n) {
      this.cachedCursor = stored;
      return stored;
    }
    const lookback = this.opts.initialLookbackBlocks ?? 1_000_000n;
    const init = head > lookback ? head - lookback : 0n;
    await this.queries.setLastIndexedBlock(init);
    this.cachedCursor = init;
    return init;
  }

  /**
   * For each new PaymentSettled event, fetch the per-paymentId
   * `getRecord` + `refundedAmount` and UPSERT a row. Sequential per
   * event so a transient RPC failure on one doesn't poison the whole
   * batch — at small batch sizes this is fine, and the row-level UPSERT
   * keeps it idempotent on retry.
   */
  private async ingest(events: PaymentSettledEventLog[]): Promise<void> {
    for (const e of events) {
      const [record, refundedAtomic] = await Promise.all([
        this.reader.getReputationRecord(e.paymentId),
        this.reader.getPaymentRefundedAmount(e.paymentId),
      ]);
      await this.queries.upsertChainEvent({
        paymentId: e.paymentId,
        txHash: e.transactionHash,
        blockNumber: e.blockNumber,
        serviceId: e.serviceId,
        buyerAgentId: e.buyerAgentId,
        providerAgentId: e.providerAgentId,
        amountAtomic: e.totalAmount,
        settledAt: new Date(Number(e.blockTimestamp) * 1000),
        outcomeCode: record?.outcomeRecorded
          ? OUTCOME_TO_CODE[record.outcome ?? "Completed"]
          : null,
        confirmationCode: CONFIRMATION_TO_CODE[record?.confirmation ?? "Pending"],
        fulfillmentSeconds:
          record?.fulfillmentSeconds != null
            ? Number(record.fulfillmentSeconds)
            : null,
        refundedAtomic,
      });
    }
  }

  /**
   * Re-poll rows whose state is still mutable (no refund, no terminal
   * confirmation) and that haven't been refreshed within
   * `refreshIntervalMs`. Cheap multicall per row; bounded batch size
   * keeps tick latency predictable.
   */
  private async refreshPending(): Promise<void> {
    const intervalMs = this.opts.refreshIntervalMs ?? 60_000;
    const batchSize = this.opts.refreshBatchSize ?? 20;
    const cutoff =
      intervalMs === 0
        ? new Date(8_640_000_000_000_000)
        : new Date(Date.now() - intervalMs);
    const stale = await this.queries.listStaleChainEvents(cutoff, batchSize);
    if (stale.length === 0) return;

    for (const row of stale) {
      const [record, refundedAtomic] = await Promise.all([
        this.reader.getReputationRecord(row.paymentId),
        this.reader.getPaymentRefundedAmount(row.paymentId),
      ]);
      await this.queries.refreshChainEvent({
        paymentId: row.paymentId,
        outcomeCode: record?.outcomeRecorded
          ? OUTCOME_TO_CODE[record.outcome ?? "Completed"]
          : null,
        confirmationCode: CONFIRMATION_TO_CODE[record?.confirmation ?? "Pending"],
        fulfillmentSeconds:
          record?.fulfillmentSeconds != null
            ? Number(record.fulfillmentSeconds)
            : null,
        refundedAtomic,
      });
    }
  }
}

// Mirror the Solidity enum order used by ReputationStorage:
//   outcome:       0=Completed, 1=Failed, 2=Canceled
//   confirmation:  0=Pending, 1=Confirmed, 2=NotConfirmed
const OUTCOME_TO_CODE: Record<"Completed" | "Failed" | "Canceled", number> = {
  Completed: 0,
  Failed: 1,
  Canceled: 2,
};
const CONFIRMATION_TO_CODE: Record<"Pending" | "Confirmed" | "NotConfirmed", number> = {
  Pending: 0,
  Confirmed: 1,
  NotConfirmed: 2,
};
