import type { PoolClient } from "pg";
import type { Pool } from "./pool.js";

export function createTransactionQueries(pool: Pool) {
  return {
    async withDatabaseTransaction<T>(
      action: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await action(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
