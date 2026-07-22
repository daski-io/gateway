import type { ChainStatusReader } from "../chain/reader.js";
import type { Config } from "../config.js";

const READINESS_PROBE_ACCOUNT =
  "0x0000000000000000000000000000000000000000" as const;

export class PaymentScreeningReadinessProbe {
  private ready = false;
  private validUntil = 0;
  private pending: Promise<boolean> | null = null;

  constructor(
    private readonly config: Config,
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

  private async check(): Promise<boolean> {
    try {
      this.ready = await this.reader.verifySanctionsReadiness({
        oracleAddress: this.config.sanctionsOracleAddress,
        guardedContracts: [
          this.config.paymentRouterAddress,
          this.config.x402AdapterAddress,
          this.config.agentIndexAddress,
        ],
        probeAccount: READINESS_PROBE_ACCOUNT,
        chainId: this.config.chainId,
      });
    } catch {
      this.ready = false;
    }
    this.validUntil = Date.now() + this.ttlMs;
    return this.ready;
  }
}
