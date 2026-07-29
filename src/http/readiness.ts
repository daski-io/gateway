import type { Pool } from "../db/pool.js";

export class DatabaseReadinessProbe {
  private ready = false;
  private validUntil = 0;
  private pending: Promise<boolean> | null = null;

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
        `SELECT NOT EXISTS (
           SELECT 1
             FROM payment_challenges
            WHERE settlement_recovery_failure_category =
              'prepared_transaction_nonce_conflict'
         ) AS ready`,
      );
      this.ready = result.rows[0]?.ready === true;
    } catch {
      this.ready = false;
    }
    this.validUntil = Date.now() + this.ttlMs;
    return this.ready;
  }
}
