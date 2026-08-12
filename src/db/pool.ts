import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { logger } from "../util/logger.js";

export type Pool = pg.Pool;

export interface CreatePoolOptions {
  connectionString: string;
  /**
   * Comma-separated schema list set on every checked-out connection.
   * Tests use this to isolate to a per-test schema; production callers
   * leave it undefined and rely on the database default ("public").
   */
  searchPath?: string;
  max?: number;
}

/**
 * Isolates session-level advisory locks from the queries executed while those
 * locks are held. Separate lock domains prevent nested work from exhausting
 * the pool that its outer lock already occupies.
 */
export interface DatabasePools {
  main: Pool;
  challengeSettlement: Pool;
  facilitatorTransaction: Pool;
  providerFeedback: Pool;
}

const MAIN_POOL_MAX = 10;
const CHALLENGE_SETTLEMENT_POOL_MAX = 10;
const FACILITATOR_TRANSACTION_POOL_MAX = 2;
const PROVIDER_FEEDBACK_POOL_MAX = 2;

export function createPool(opts: CreatePoolOptions): Pool {
  let options: string | undefined;
  if (opts.searchPath !== undefined) {
    const names = opts.searchPath.split(",").map((name) => name.trim());
    if (
      names.length === 0 ||
      names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    ) {
      throw new Error("searchPath contains an invalid schema name");
    }
    // Apply the path in PostgreSQL's startup packet. An asynchronous
    // `pool.on("connect")` query races the caller's first query and pg 9
    // no longer permits that overlapping use of a newly connected client.
    options = `-c search_path=${names.join(",")}`;
  }
  return new pg.Pool({
    connectionString: opts.connectionString,
    ...(opts.max === undefined ? {} : { max: opts.max }),
    ...(options ? { options } : {}),
  });
}

export function createDatabasePools(
  opts: Omit<CreatePoolOptions, "max">,
): DatabasePools {
  return {
    main: createPool({ ...opts, max: MAIN_POOL_MAX }),
    challengeSettlement: createPool({
      ...opts,
      max: CHALLENGE_SETTLEMENT_POOL_MAX,
    }),
    facilitatorTransaction: createPool({
      ...opts,
      max: FACILITATOR_TRANSACTION_POOL_MAX,
    }),
    providerFeedback: createPool({
      ...opts,
      max: PROVIDER_FEEDBACK_POOL_MAX,
    }),
  };
}

/**
 * Apply pending migrations from src/db/migrations (or dist/db/migrations
 * after build). Each .sql file is run in a single transaction and recorded
 * in the `_migrations` table so it isn't re-applied. Mirrors the
 * provider's runner so the operational surface is identical.
 */
export async function runMigrations(
  pool: Pool,
  options: { through?: string } = {},
): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.join(__dirname, "migrations");
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      ["daski-gateway:migrations"],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query("ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
    const applied = await client.query<{ name: string; checksum: string | null }>(
      "SELECT name,checksum FROM _migrations ORDER BY name",
    );
    const appliedMap = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => options.through === undefined || f <= options.through)
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      if (appliedMap.has(file)) {
        const recorded = appliedMap.get(file);
        if (recorded && recorded !== checksum) {
          throw new Error(`Applied migration checksum changed: ${file}`);
        }
        if (!recorded) {
          await client.query("UPDATE _migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL", [file, checksum]);
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name,checksum) VALUES ($1,$2)", [file, checksum]);
        await client.query("COMMIT");
        logger.info("database migration applied", { migration: file });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    await client.query("ALTER TABLE _migrations ALTER COLUMN checksum SET NOT NULL");
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        "daski-gateway:migrations",
      ])
      .catch(() => undefined);
    client.release();
  }
}
