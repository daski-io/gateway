import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { createRateLimitQueries } from "../src/db/rateLimitQueries.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("rate-limit buckets against PostgreSQL", () => {
  it("counts without waiting for a WAL flush and leaves the connection's next commit durable", async () => {
    const schema = `rate_limits_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    // One connection, so every statement below runs in the same session.
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 1 });
    const synchronousCommit = async (db: Pick<Pool, "query">) =>
      (await db.query<{ synchronous_commit: string }>("SHOW synchronous_commit")).rows[0]!.synchronous_commit;
    try {
      await runMigrations(pool);
      const buckets = createRateLimitQueries(pool);
      expect(await synchronousCommit(pool)).toBe("on");
      await expect(buckets.consumeRateLimitBucket("public-read:198.51.100.7", 60_000))
        .resolves.toMatchObject({ count: 1 });
      await expect(buckets.consumeRateLimitBucket("public-read:198.51.100.7", 60_000))
        .resolves.toMatchObject({ count: 2 });
      // Each count ran in its own implicit transaction; the setting ended with it.
      expect(await synchronousCommit(pool)).toBe("on");

      // Inside an explicit transaction the setting is observable: the count's
      // own transaction commits asynchronously.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(createRateLimitQueries(client as unknown as Pool)
          .consumeRateLimitBucket("public-read:198.51.100.7", 60_000)).resolves.toMatchObject({ count: 3 });
        expect(await synchronousCommit(client)).toBe("off");
        await client.query("COMMIT");
        expect(await synchronousCommit(client)).toBe("on");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);
});
