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
  /**
   * How long a caller waits for a free client before the checkout fails.
   * Without it a saturated pool queues callers forever, which turned a
   * settlement-time lock pile-up into a whole-process stall. Defaults to
   * 10 s; `0` keeps pg's unbounded wait (migration runners).
   */
  connectionTimeoutMs?: number;
  /** Session `statement_timeout` applied in the startup packet; `0` disables. */
  statementTimeoutMs?: number;
  /** Session `lock_timeout` applied in the startup packet; `0` disables. */
  lockTimeoutMs?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

function positiveMilliseconds(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer number of milliseconds`);
  }
  return resolved;
}

export function createPool(opts: CreatePoolOptions): Pool {
  const startup: string[] = [];
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
    startup.push(`-c search_path=${names.join(",")}`);
  }
  const statementTimeout = positiveMilliseconds(
    "statementTimeoutMs", opts.statementTimeoutMs, DEFAULT_STATEMENT_TIMEOUT_MS,
  );
  const lockTimeout = positiveMilliseconds("lockTimeoutMs", opts.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  if (statementTimeout > 0) startup.push(`-c statement_timeout=${statementTimeout}`);
  if (lockTimeout > 0) startup.push(`-c lock_timeout=${lockTimeout}`);
  const connectionTimeout = positiveMilliseconds(
    "connectionTimeoutMs", opts.connectionTimeoutMs, DEFAULT_CONNECTION_TIMEOUT_MS,
  );
  return new pg.Pool({
    connectionString: opts.connectionString,
    ...(opts.max === undefined ? {} : { max: opts.max }),
    ...(startup.length > 0 ? { options: startup.join(" ") } : {}),
    ...(connectionTimeout > 0 ? { connectionTimeoutMillis: connectionTimeout } : {}),
  });
}

/**
 * Apply pending migrations from src/db/migrations (or dist/db/migrations
 * after build). Each file is recorded in `_migrations`; related retirement
 * changes publish atomically in one transaction. Lock contention rolls back
 * the whole pending transaction and yields to the serving runtime.
 */
export async function runMigrations(
  pool: Pool,
  options: { through?: string; timeoutMs?: number } = {},
): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.join(__dirname, "migrations");
  const deadline = Date.now() + positiveMilliseconds("migration timeout", options.timeoutMs, 120_000);
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("Migration startup time budget exhausted");
    return ms;
  };
  const client = await pool.connect();
  let acquired = false;
  try {
    // A competing candidate may hold this lock while yielding to serving
    // traffic. Poll without inheriting the runtime's five-second lock timeout.
    while (!acquired) {
      remaining();
      acquired = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        ["daski-gateway:migrations"])).rows[0].acquired;
      if (!acquired) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining())));
    }
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

    const pending: Array<{ file: string; sql: string; checksum: string }> = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      if (appliedMap.has(file)) {
        const recorded = appliedMap.get(file);
        if (recorded && recorded !== checksum) throw new Error("Applied migration checksum changed: " + file);
        if (!recorded) await client.query("UPDATE _migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL", [file, checksum]);
      } else pending.push({ file, sql, checksum });
    }
    for (let index = 0; index < pending.length;) {
      const batch = [pending[index++]!];
      // Publish the retirement trigger and its correction atomically on a
      // legacy schema. Applied migration bytes/checksums stay immutable.
      if (batch[0]!.file >= "056_" && batch[0]!.file <= "059_zz") {
        while (index < pending.length && pending[index]!.file <= "059_zz") batch.push(pending[index++]!);
      }
      for (;;) {
        remaining();
        await client.query("BEGIN");
        try {
          // Never let a waiting ACCESS EXCLUSIVE DDL lock queue serving reads
          // for seconds. Retry the whole uncommitted expansion after yielding.
          await client.query("SET LOCAL lock_timeout='50ms'");
          for (const migration of batch) {
            await client.query("SELECT set_config('statement_timeout', $1, true)", [String(remaining())]);
            await client.query(migration.sql);
            await client.query("INSERT INTO _migrations (name,checksum) VALUES ($1,$2)", [migration.file,migration.checksum]);
          }
          await client.query("COMMIT");
          for (const migration of batch) logger.info("database migration applied", { migration: migration.file });
          break;
        } catch (err) {
          await client.query("ROLLBACK");
          const code = (err as { code?: string }).code;
          if (!["40P01", "55P03"].includes(code ?? "") || Date.now() >= deadline) throw err;
          await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
        }
      }
    }
    await client.query("ALTER TABLE _migrations ALTER COLUMN checksum SET NOT NULL");
  } finally {
    if (acquired) await client
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        "daski-gateway:migrations",
      ])
      .catch(() => undefined);
    client.release();
  }
}
