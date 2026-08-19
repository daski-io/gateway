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

      await pool.query(
        `INSERT INTO standard_rail_artifacts
          (artifact_hash,artifact_type,schema_version,environment,chain_id,canonical_json,valid_before)
         VALUES ($1,'ListingCommitmentV2',2,'sandbox',84532,'{}',now() + interval '1 hour')`,
        [Buffer.alloc(32, 2)],
      );
      await expect(
        pool.query(
          `INSERT INTO standard_rail_artifacts
            (artifact_hash,artifact_type,schema_version,environment,chain_id,canonical_json,valid_before)
           VALUES ($1,'FutureArtifactV3',3,'sandbox',84532,'{}',now() + interval '1 hour')`,
          [Buffer.alloc(32, 3)],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const versions = await pool.query<{ schema_version: number }>(
        "SELECT schema_version FROM standard_rail_artifacts ORDER BY schema_version",
      );
      expect(versions.rows).toEqual([{ schema_version: 2 }]);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
