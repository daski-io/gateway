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
      await this.pool.query("SELECT 1");
      this.ready = true;
    } catch {
      this.ready = false;
    }
    this.validUntil = Date.now() + this.ttlMs;
    return this.ready;
  }
}
