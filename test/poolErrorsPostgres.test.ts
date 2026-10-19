import { describe, expect, it, vi } from "vitest";
import { createPool } from "../src/db/pool.js";
import { logger } from "../src/util/logger.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("database pools when the database ends their connections", () => {
  it("keeps serving after idle and checked-out connections are terminated", async () => {
    const reported = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const admin = createPool({ connectionString: databaseUrl, max: 1, name: "admin" });
    const pool = createPool({ connectionString: databaseUrl, max: 2, name: "runtime" });
    try {
      const backendPid = async (client: { query: typeof pool.query }) =>
        (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const held = await pool.connect();
      const heldPid = await backendPid(held);
      const idle = await pool.connect();
      const idlePid = await backendPid(idle);
      idle.release();

      // What a database restart does to every connection, one idle and one held between queries.
      await admin.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [[heldPid, idlePid]]);
      for (let attempt = 0; attempt < 100 && reported.mock.calls.length < 2; attempt += 1) await delay(50);

      expect(reported.mock.calls.map(([message, details]) => [message, (details as { pool: string }).pool]))
        .toEqual([["database connection lost", "runtime"], ["database connection lost", "runtime"]]);
      // The holder's next query fails, and releasing the broken client discards it.
      await expect(held.query("SELECT 1")).rejects.toThrow();
      held.release();
      // The pool serves the next query on a fresh connection.
      expect((await pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok).toBe(1);
      expect(pool.totalCount).toBe(1);
    } finally {
      reported.mockRestore();
      await pool.end();
      await admin.end();
    }
  }, 20_000);
});
