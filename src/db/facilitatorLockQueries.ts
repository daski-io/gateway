import type { Pool } from "./pool.js";

/**
 * Serializes facilitator nonce allocation across replicas. The lock is
 * released by the write's onBroadcast callback, after any transaction hash
 * persistence, so chain confirmation waits never block the next nonce.
 */
export function createFacilitatorLockQueries(pool: Pool) {
  return {
    async withFacilitatorTransactionLock<T>(
      action: (release: () => Promise<void>) => Promise<T>,
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
        await client.query(
          "SELECT pg_advisory_lock(hashtextextended($1, 0))",
          [lockName],
        );
        return await action(release);
      } finally {
        await release();
      }
    },
  };
}
