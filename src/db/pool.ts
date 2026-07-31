import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
export async function runMigrations(pool: Pool): Promise<void> {
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
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<{ name: string }>(
      "SELECT name FROM _migrations ORDER BY name",
    );
    const appliedSet = new Set(applied.rows.map((r) => r.name));
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        logger.info("database migration applied", { migration: file });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        "daski-gateway:migrations",
      ])
      .catch(() => undefined);
    client.release();
  }
}
