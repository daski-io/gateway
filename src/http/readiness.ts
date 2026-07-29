import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";

export class DatabaseReadinessProbe {
  private ready = false;
  private validUntil = 0;
  private pending: Promise<boolean> | null = null;
  private reportedUnready = false;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = 2_000,
  ) {}

  async isReady(): Promise<boolean> {
    const now = Date.now();
    if (now < this.validUntil) return this.ready;
    if (this.pending) return this.pending;

    this.pending = this.check();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async check(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `WITH facilitator_reservations AS (
           SELECT service_ref::text AS owner_key
             FROM payment_challenges
            WHERE settlement_state = 'settlement_prepared'
           UNION ALL
           SELECT payment_id::text AS owner_key
             FROM reputation_mirrors
            WHERE prepared_tx IS NOT NULL
              AND tx_nonce IS NOT NULL
              AND tx_hash IS NOT NULL
              AND broadcast_at IS NULL
         )
         SELECT
           NOT EXISTS (
             SELECT 1
               FROM payment_challenges
              WHERE settlement_recovery_failure_category =
                'prepared_transaction_nonce_conflict'
           )
           AND (SELECT count(*) FROM facilitator_reservations) <= 1
           AND NOT EXISTS (
             SELECT 1
               FROM reputation_mirrors
              WHERE status = 'failed'
                AND prepared_tx IS NOT NULL
                AND tx_nonce IS NOT NULL
           ) AS ready`,
      );
      this.ready = result.rows[0]?.ready === true;
      if (!this.ready && !this.reportedUnready) {
        logger.error("database readiness blocked by facilitator state", {
          failureCode: "facilitator_reservation_conflict",
        });
        this.reportedUnready = true;
      } else if (this.ready) {
        this.reportedUnready = false;
      }
    } catch {
      this.ready = false;
    }
    this.validUntil = Date.now() + this.ttlMs;
    return this.ready;
  }
}
