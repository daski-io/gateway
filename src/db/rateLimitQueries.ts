import type { Pool } from "./pool.js";

export function createRateLimitQueries(pool: Pool) {
  return {
    async consumeRateLimitBucket(
      bucketKey: string,
      windowMs: number,
    ): Promise<{ count: number; resetAt: Date }> {
      const result = await pool.query<{
        request_count: number;
        reset_at: Date;
      }>(
        `INSERT INTO rate_limit_buckets
           (bucket_key, window_started_at, request_count)
         VALUES ($1, now(), 1)
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
