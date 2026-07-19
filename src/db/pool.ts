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
}

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
    ...(options ? { options } : {}),
  });
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query<{ name: string }>(
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info("database migration applied", { migration: file });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
