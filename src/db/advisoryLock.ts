import type { PoolClient } from "pg";
import type { Pool } from "./pool.js";

const POLL_INTERVAL_MS = 100;

export interface AdvisoryLockOptions {
  /** `shared` takes `pg_advisory_lock_shared`; the default is exclusive. */
  mode?: "exclusive" | "shared";
  /**
   * How long to keep retrying a busy lock. `0` tries exactly once. A
   * waiter never holds a pooled connection between attempts: session
   * advisory locks belong to the connection that acquired them, so only a
   * holder keeps a client checked out, and only for the duration of `work`.
   */
  waitMs?: number;
  /** Runs on the holder's connection right after the lock is acquired. */
  prepare?: (client: PoolClient) => Promise<void>;
}

export type AdvisoryLockOutcome<T> =
  | { acquired: true; result: T }
  | { acquired: false };

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

/**
 * Session advisory lock held for the duration of `work`, acquired with the
 * non-blocking `pg_try_advisory_lock` variants and short polling. Blocking
 * `pg_advisory_lock` on a pooled connection pins that connection for as long
 * as the current holder runs; with settlement holders waiting on chain
 * finality, a handful of concurrent waiters could exhaust the pool and starve
 * the holder itself (audit H2, 2026-09-01).
 */
export async function tryWithAdvisoryLock<T>(
  pool: Pool,
  key: string,
  work: () => Promise<T>,
  options: AdvisoryLockOptions = {},
): Promise<AdvisoryLockOutcome<T>> {
  const shared = options.mode === "shared";
  const acquire = shared
    ? "SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) AS acquired"
    : "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired";
  const release = shared
    ? "SELECT pg_advisory_unlock_shared(hashtextextended($1,0))"
    : "SELECT pg_advisory_unlock(hashtextextended($1,0))";
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  for (;;) {
    const client = await pool.connect();
    let held = false;
    try {
      const attempt = await client.query<{ acquired: boolean }>(acquire, [key]);
      held = attempt.rows[0]?.acquired === true;
      if (held) {
        if (options.prepare) await options.prepare(client);
        return { acquired: true, result: await work() };
      }
    } finally {
      if (held) await client.query(release, [key]).catch(() => undefined);
      client.release();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { acquired: false };
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

export class AdvisoryLockBusyError extends Error {
  constructor(key: string) {
    super(`ADVISORY_LOCK_BUSY:${key}`);
    this.name = "AdvisoryLockBusyError";
  }
}

/** Like `tryWithAdvisoryLock` but a busy lock past `waitMs` is an error. */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  work: () => Promise<T>,
  options: AdvisoryLockOptions = {},
): Promise<T> {
  const outcome = await tryWithAdvisoryLock(pool, key, work, options);
  if (!outcome.acquired) throw new AdvisoryLockBusyError(key);
  return outcome.result;
}
