import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

export function createChallengeSettlementLock(pool: Pool) {
  const settlementGates = new Map<string, Promise<void>>();

  return {
    async withChallengeSettlementLock<T>(
      serviceRef: Hex,
      action: () => Promise<T>,
    ): Promise<T> {
      const lockKey = serviceRef.toLowerCase();
      let releaseGate!: () => void;
      const previous = settlementGates.get(lockKey) ?? Promise.resolve();
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      settlementGates.set(lockKey, gate);
      await previous;
      try {
        const client = await pool.connect();
        let locked = false;
        try {
          await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
            lockKey,
          ]);
          locked = true;
          return await action();
        } finally {
          try {
            if (locked) {
              await client.query(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                [lockKey],
              );
            }
          } finally {
            client.release();
          }
        }
      } finally {
        releaseGate();
        if (settlementGates.get(lockKey) === gate) settlementGates.delete(lockKey);
      }
    },
  };
}
