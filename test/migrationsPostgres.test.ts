import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

describe("gateway migrations", () => {
  it("builds the complete schema from an empty database namespace", async () => {
    const schema = `gateway_migrations_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({
      connectionString: databaseUrl,
      searchPath: `${schema},public`,
      max: 1,
    });
    try {
      await runMigrations(pool);
      await runMigrations(pool);

      const migrationCount = readdirSync(
        new URL("../src/db/migrations", import.meta.url),
      ).filter((name) => name.endsWith(".sql")).length;
      const applied = await pool.query<{ count: number; checksums: number }>(
        "SELECT count(*)::int AS count, count(checksum)::int AS checksums FROM _migrations",
      );
      expect(applied.rows[0]).toEqual({
        count: migrationCount,
        checksums: migrationCount,
      });
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
