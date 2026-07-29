import { FeedbackSubmissionError } from "../chain/feedbackErrors.js";
import type {
  ChainReader,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
} from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries, ReputationMirrorRow } from "../db/queries.js";
import { REPUTATION_MIRROR_MAX_ATTEMPTS } from "../db/reputationQueries.js";
import type { Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { logger } from "../util/logger.js";
import { buildFeedbackInput } from "./mirror.js";

export interface ReputationMirrorWorkerDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
}

export class ReputationMirrorWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  private lastSuccessAt: Date | null = null;
  private lastError: { message: string; at: Date } | null = null;

  constructor(private readonly deps: ReputationMirrorWorkerDeps) {}

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
    const operation = this.runTick();
    return this.track(operation);
  }

  private async runTick(): Promise<void> {
    this.running = true;
    try {
      await this.reconcileMissing();
      for (let i = 0; i < 20; i++) {
        const row = await this.deps.queries.claimReputationMirror();
        if (!row) break;
        await this.processClaimed(row);
      }
      this.lastSuccessAt = new Date();
      this.lastError = null;
    } catch (error) {
      this.lastError = {
        message: error instanceof Error ? error.message : String(error),
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

  status() {
    return {
      enabled: this.enabled(),
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  private async processPayment(paymentId: bigint): Promise<void> {
    try {
      const row = await this.deps.queries.claimReputationMirror(paymentId);
      if (row) await this.processClaimed(row);
    } catch (error) {
      logErrorWithId("reputationMirror.processPayment", error);
    }
  }

  private async processClaimed(row: ReputationMirrorRow): Promise<void> {
    try {
      const [record, challenge] = await Promise.all([
        this.deps.reader.getPaymentRecord(row.paymentId),
        this.deps.queries.getChallengeByPaymentId(row.paymentId),
      ]);
      if (!record) throw new Error("authoritative payment record not found");
      if (!record.reputationEligible) {
        await this.deps.queries.markReputationMirrorResult({
          paymentId: row.paymentId,
          status: "skipped",
          error: "payment is not reputation eligible",
        });
        return;
      }
      if (!row.confirmation) {
        throw new Error("mirror row has no confirmation label");
      }
      const feedback = buildFeedbackInput({
        config: this.deps.config,
        providerAgentId: record.providerAgentId,
        confirmation: row.confirmation,
        attestationUid: row.attestationUid,
        serviceSlug: challenge?.serviceSlug ?? "",
      });
      await this.deps.queries.withProviderFeedbackLock(
        record.providerAgentId,
        async () => {
          if (row.refUid && row.feedbackIndex != null) {
            try {
              await this.deps.queries.withFacilitatorTransactionLock(
                (release) =>
                  this.deps.reader.revokeFeedback(
                    row.providerAgentId ?? record.providerAgentId,
                    row.feedbackIndex!,
                    release,
                  ),
              );
            } catch (error) {
              logErrorWithId("reputationMirror.revoke", error);
            }
          }
          const result = await this.submit(row, feedback);
          if (result.feedbackIndex == null) {
            throw new FeedbackSubmissionError(
              "malformed_event",
              "NewFeedback event did not include feedbackIndex",
            );
          }
          await this.deps.queries.markReputationMirrorSent({
            paymentId: row.paymentId,
            providerAgentId: record.providerAgentId,
            feedbackIndex: result.feedbackIndex,
            transactionHash: result.transactionHash,
          });
        },
      );
    } catch (error) {
      await this.handleFailure(row, error);
    }
  }

  private async submit(
    row: ReputationMirrorRow,
    input: FeedbackInput,
  ): Promise<FeedbackResult> {
    return this.deps.queries.withFacilitatorTransactionLock(async (release) => {
      let prepared = this.preparedFromRow(row);
      if (prepared) {
        const recovered = await this.deps.reader.getFeedbackByTransaction(
          prepared.transactionHash,
          input,
        );
        if (recovered) {
          await release();
          return recovered;
        }
        const nextNonce =
          await this.deps.reader.getFacilitatorTransactionCount();
        if (nextNonce > prepared.nonce) {
          await this.deps.queries.markReputationMirrorResult({
            paymentId: row.paymentId,
            status: "retry",
            error: "prepared transaction nonce was consumed by another write",
            clearPrepared: true,
          });
          throw new NonceConsumedError();
        }
      } else {
        prepared = await this.deps.reader.prepareFeedback(input);
        await this.deps.queries.markReputationMirrorPrepared({
          paymentId: row.paymentId,
          transactionHash: prepared.transactionHash,
          preparedTransaction: prepared.serializedTransaction,
          transactionNonce: prepared.nonce,
        });
      }
      return this.deps.reader.submitPreparedFeedback(
        prepared,
        input,
        async (hash) => {
          await this.deps.queries.markReputationMirrorBroadcast(
            row.paymentId,
            hash,
          );
          await release();
        },
      );
    });
  }

  private preparedFromRow(
    row: ReputationMirrorRow,
  ): PreparedFeedbackTransaction | null {
    if (
      !row.preparedTransaction ||
      !row.txHash ||
      row.transactionNonce == null
    ) {
      return null;
    }
    return {
      serializedTransaction: row.preparedTransaction,
      transactionHash: row.txHash,
      nonce: row.transactionNonce,
    };
  }

  private async handleFailure(
    row: ReputationMirrorRow,
    error: unknown,
  ): Promise<void> {
    if (error instanceof NonceConsumedError) return;
    const message = error instanceof Error ? error.message : String(error);
    const terminal =
      error instanceof FeedbackSubmissionError ||
      row.attempts >= REPUTATION_MIRROR_MAX_ATTEMPTS;
    await this.deps.queries.markReputationMirrorResult({
      paymentId: row.paymentId,
      status: terminal ? "failed" : "retry",
      error: message,
    });
    logErrorWithId("reputationMirror.process", error);
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
}

class NonceConsumedError extends Error {}
