import type { Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { classifyOperationalError } from "../util/logSanitizer.js";
import { logger } from "../util/logger.js";
import {
  ReputationMirrorProcessor,
  type ReputationMirrorWorkerDeps,
} from "./processor.js";

export type { ReputationMirrorWorkerDeps } from "./processor.js";

export class ReputationMirrorWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  private readonly processor: ReputationMirrorProcessor;
  private lastSuccessAt: Date | null = null;
  private lastError: {
    code: string;
    message: string;
    at: Date;
  } | null = null;

  constructor(private readonly deps: ReputationMirrorWorkerDeps) {
    this.processor = new ReputationMirrorProcessor(deps);
  }

  enabled(): boolean {
    return (
      this.deps.config.chainMode !== "mock" &&
      Boolean(this.deps.config.reputationRegistryAddress)
    );
  }

  start(): void {
    if (!this.enabled() || this.timer || this.stopping) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 5_000);
  }

  async stopAndDrain(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.active]);
  }

  async enqueue(input: {
    paymentId: bigint;
    confirmation: "Confirmed" | "NotConfirmed";
    attestationUid: Hex;
    refUid: Hex | null;
  }): Promise<void> {
    if (!this.enabled() || this.stopping) return;
    const queued = await this.deps.queries.enqueueReputationMirror(input);
    if (queued && !this.stopping) {
      void this.track(this.processPayment(input.paymentId));
    }
  }

  async tick(): Promise<void> {
    if (!this.enabled() || this.running || this.stopping) return;
    return this.track(this.runTick());
  }

  status() {
    return {
      enabled: this.enabled(),
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  private async runTick(): Promise<void> {
    this.running = true;
    try {
      await this.reconcileMissing();
      await this.reconcileFacilitatorTransactions();
      for (let index = 0; index < 20; index++) {
        const row = await this.deps.queries.claimReputationMirror();
        if (!row) break;
        await this.processor.process(row);
      }
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (error) {
      const safeError = classifyOperationalError(
        error,
        "reputation_tick_failed",
        "reputation mirror tick failed",
      );
      this.lastError = {
        code: safeError.code,
        message: safeError.message,
        at: new Date(),
      };
      logErrorWithId("reputationMirror.tick", error);
    } finally {
      this.running = false;
    }
  }

  private async track(operation: Promise<void>): Promise<void> {
    this.active.add(operation);
    try {
      await operation;
    } finally {
      this.active.delete(operation);
    }
  }

  private async processPayment(paymentId: bigint): Promise<void> {
    try {
      const row = await this.deps.queries.claimReputationMirror(paymentId);
      if (row) await this.processor.process(row);
    } catch (error) {
      logErrorWithId("reputationMirror.processPayment", error);
    }
  }

  private async reconcileMissing(): Promise<void> {
    const missing = await this.deps.queries.listMissingReputationMirrors();
    for (const item of missing) {
      const record = await this.deps.reader.getReputationRecord(item.paymentId);
      if (
        record?.confirmation !== "Confirmed" &&
        record?.confirmation !== "NotConfirmed"
      ) {
        continue;
      }
      await this.deps.queries.enqueueReputationMirror({
        paymentId: item.paymentId,
        confirmation: record.confirmation,
        attestationUid: item.attestationUid,
        refUid: null,
      });
    }
    if (missing.length > 0) {
      logger.info("reputation mirror reconciliation completed", {
        candidates: missing.length,
      });
    }
  }

  private async reconcileFacilitatorTransactions(): Promise<void> {
    const transactions = [
      ...(await this.deps.queries.listDueFacilitatorTransactions(
        "feedback_revoke",
        20,
      )),
      ...(await this.deps.queries.listDueFacilitatorTransactions(
        "feedback_give",
        20,
      )),
    ];
    for (const transaction of transactions) {
      const paymentId = transaction.operationData.paymentId;
      const attestationUid = transaction.operationData.attestationUid;
      const kind =
        transaction.operationKind === "feedback_revoke" ? "revoke" : "give";
      if (
        typeof paymentId !== "string" ||
        !/^[0-9]+$/.test(paymentId) ||
        typeof attestationUid !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(attestationUid)
      ) {
        await this.deps.queries.flagReputationJournalIntegrity(
          transaction.id,
          "reputation_journal_mirror_mismatch",
        );
        continue;
      }
      const row =
        await this.deps.queries.claimReputationMirrorForTransaction({
          transactionId: transaction.id,
          paymentId: BigInt(paymentId),
          attestationUid: attestationUid.toLowerCase() as Hex,
          kind,
        });
      if (!row) {
        await this.deps.queries.flagReputationJournalIntegrity(
          transaction.id,
          "reputation_journal_mirror_mismatch",
        );
        continue;
      }
      await this.processor.process(row);
    }
  }
}
