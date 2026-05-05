import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const pool = new pg.Pool({ connectionString: opts.connectionString });
  if (opts.searchPath) {
    const sp = opts.searchPath;
    pool.on("connect", (client) => {
      // Quote each name; SET search_path takes a comma-separated list
      // of identifiers (not literals), so we have to inline.
      const ident = sp
        .split(",")
        .map((s) => `"${s.trim().replace(/"/g, '""')}"`)
        .join(", ");
      void client.query(`SET search_path TO ${ident}`);
    });
  }
  return pool;
}

export async function checkDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
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
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: `Migration applied: ${file}`,
        }),
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
