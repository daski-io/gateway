import type { Pool } from "./pool.js";

export function createRateLimitQueries(pool: Pool) {
  return {
    async consumeRateLimitBucket(
      bucketKey: string,
      windowMs: number,
    ): Promise<{ count: number; resetAt: Date }> {
      // A bucket is throttling state, not a record: a database crash that
      // loses its last increments lets a client through a few requests
      // early. Waiting for the WAL flush put storage write latency in front
      // of every limited request instead: on 2026-10-13 commits stalled for
      // up to 15 s while reads answered at once, and each public read waited
      // twice. set_config(..., true) holds only for this statement's own
      // transaction, so the connection's next commit is durable again.
      const result = await pool.query<{
        request_count: number;
        reset_at: Date;
      }>(
        `INSERT INTO rate_limit_buckets
           (bucket_key, window_started_at, request_count)
         SELECT $1::text, now(), 1
           FROM (SELECT set_config('synchronous_commit', 'off', true)) AS async_commit
         ON CONFLICT (bucket_key) DO UPDATE
           SET window_started_at =
                 CASE
                   WHEN rate_limit_buckets.window_started_at
                        <= now() - ($2 * interval '1 millisecond')
                   THEN now()
                   ELSE rate_limit_buckets.window_started_at
                 END,
               request_count =
                 CASE
                   WHEN rate_limit_buckets.window_started_at
                        <= now() - ($2 * interval '1 millisecond')
                   THEN 1
                   ELSE rate_limit_buckets.request_count + 1
                 END
         RETURNING request_count,
                   window_started_at + ($2 * interval '1 millisecond')
                     AS reset_at`,
        [bucketKey, windowMs],
      );
      const row = result.rows[0];
      if (!row) throw new Error("rate-limit bucket update returned no row");
      return { count: row.request_count, resetAt: row.reset_at };
    },

    // Every window is at most one minute; a bucket idle for ten is dead.
    async pruneRateLimitBuckets(): Promise<number> {
      const result = await pool.query(
        `DELETE FROM rate_limit_buckets
          WHERE window_started_at < now() - interval '10 minutes'`,
      );
      return result.rowCount ?? 0;
    },
  };
}
