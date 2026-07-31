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
        `SELECT
           (
             SELECT count(*)
               FROM facilitator_transactions
              WHERE status = 'prepared'
           ) <= 1
           AND NOT EXISTS (
             SELECT 1
              FROM facilitator_transactions
              WHERE failure_code IN (
                      'automatic_recovery_exhausted',
                      'reputation_journal_mirror_mismatch',
                      'reputation_projection_mismatch'
                    )
                 OR status = 'nonce_conflict'
                 OR (
                   status IN ('prepared', 'broadcast')
                   AND (
                     submission_attempts >= 8
                     OR now() - prepared_at > interval '15 minutes'
                   )
                 )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM buyer_confirmation_submissions AS submission
               JOIN facilitator_transactions AS transaction
                 ON transaction.id = submission.facilitator_transaction_id
              WHERE (
                submission.status = 'prepared'
                AND transaction.status <> 'prepared'
              ) OR (
                submission.status = 'broadcast'
                AND transaction.status <> 'broadcast'
              )
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
