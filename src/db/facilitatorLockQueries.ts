import type { Pool } from "./pool.js";
import type { Hex } from "../types.js";

export class SettlementOutboxPendingError extends Error {
  constructor() {
    super("a prepared settlement is awaiting reconciliation");
    this.name = "SettlementOutboxPendingError";
  }
}

/**
 * Serializes facilitator nonce allocation across replicas. The lock is
 * released by the write's onBroadcast callback, after any transaction hash
 * persistence, so chain confirmation waits never block the next nonce.
 */
export function createFacilitatorLockQueries(pool: Pool) {
  return {
    async withFacilitatorTransactionLock<T>(
      action: (release: () => Promise<void>) => Promise<T>,
      options: { settlementServiceRef?: Hex } = {},
    ): Promise<T> {
      const client = await pool.connect();
      const lockName = "daski:facilitator-wallet";
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lockName],
          );
        } finally {
          client.release();
        }
      };
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          lockName,
        ]);
        const pending = await client.query<{ service_ref: Buffer }>(
          `SELECT service_ref
             FROM payment_challenges
            WHERE settlement_state = 'settlement_prepared'
            ORDER BY prepared_at
            LIMIT 1`,
        );
        const activeRef = pending.rows[0]
          ? `0x${pending.rows[0].service_ref.toString("hex")}`
          : null;
        if (
          activeRef &&
          activeRef.toLowerCase() !==
            options.settlementServiceRef?.toLowerCase()
        ) {
          throw new SettlementOutboxPendingError();
        }
        return await action(release);
      } finally {
        await release();
      }
    },
  };
}
