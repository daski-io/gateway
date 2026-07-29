import type { ChainStatusReader } from "../chain/reader.js";

export class ChainDeploymentReadinessProbe {
  private ready = false;
  private failedCheck: string | null = "not_checked";
  private validUntil = 0;
  private pending: Promise<boolean> | null = null;

  constructor(
    private readonly reader: ChainStatusReader,
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

  status() {
    return { ready: this.ready, failedCheck: this.failedCheck };
  }

  private async check(): Promise<boolean> {
    try {
      const result = await this.reader.verifyDeploymentReadiness();
      this.ready = result.ready;
      this.failedCheck = result.failedCheck;
    } catch {
      this.ready = false;
      this.failedCheck = "rpc_unavailable";
    }
    this.validUntil = Date.now() + this.ttlMs;
    return this.ready;
  }
}
