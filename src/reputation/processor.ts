import { FeedbackSubmissionError } from "../chain/feedbackErrors.js";
import type { ChainReader, FeedbackInput } from "../chain/reader.js";
import type { Config } from "../config.js";
import { FacilitatorOutboxPendingError } from "../db/facilitatorLockQueries.js";
import type { Queries, ReputationMirrorRow } from "../db/queries.js";
import { REPUTATION_MIRROR_MAX_ATTEMPTS } from "../db/reputationQueries.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { logger } from "../util/logger.js";
import { buildFeedbackInput } from "./mirror.js";
import {
  ReputationNonceConflictError,
  ReputationReceiptPendingError,
  ReputationStateConflictError,
  submitReputationFeedback,
} from "./submission.js";

export interface ReputationMirrorWorkerDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
}

export class ReputationMirrorProcessor {
  constructor(private readonly deps: ReputationMirrorWorkerDeps) {}

  async process(row: ReputationMirrorRow): Promise<void> {
    this.logDelayedTransaction(row);
    try {
      const [record, challenge] = await Promise.all([
        this.deps.reader.getPaymentRecord(row.paymentId),
        this.deps.queries.getChallengeByPaymentId(row.paymentId),
      ]);
      if (!record) throw new Error("authoritative payment record not found");
      if (!record.reputationEligible && !row.broadcastAt) {
        await this.recordIneligible(row);
        return;
      }
      if (!row.confirmation) throw new Error("mirror confirmation is missing");
      const feedback = buildFeedbackInput({
        config: this.deps.config,
        providerAgentId: record.providerAgentId,
        confirmation: row.confirmation,
        attestationUid: row.attestationUid,
        serviceSlug: challenge?.serviceSlug ?? "",
      });
      await this.deps.queries.withProviderFeedbackLock(
        record.providerAgentId,
        async () => this.processFeedback(row, feedback, record.providerAgentId),
      );
    } catch (error) {
      await this.handleFailure(row, error);
    }
  }

  private async processFeedback(
    row: ReputationMirrorRow,
    feedback: FeedbackInput,
    providerAgentId: bigint,
  ): Promise<void> {
    if (row.refUid && row.feedbackIndex != null && !row.preparedTransaction) {
      try {
        await this.deps.queries.withFacilitatorTransactionLock((release) =>
          this.deps.reader.revokeFeedback(
            row.providerAgentId ?? providerAgentId,
            row.feedbackIndex!,
            release,
          ),
        );
      } catch (error) {
        logErrorWithId("reputationMirror.revoke", error);
      }
    }
    const result = await submitReputationFeedback(
      this.deps.queries,
      this.deps.reader,
      row,
      feedback,
    );
    if (result.feedbackIndex == null) {
      throw new FeedbackSubmissionError(
        "malformed_event",
        "NewFeedback event did not include feedbackIndex",
      );
    }
    await this.deps.queries.finishReputationMirrorTransaction({
      paymentId: row.paymentId,
      attestationUid: row.attestationUid,
      transactionHash: result.transactionHash,
      outcome: {
        status: "sent",
        providerAgentId,
        feedbackIndex: result.feedbackIndex,
      },
    });
  }

  private async recordIneligible(row: ReputationMirrorRow): Promise<void> {
    if (row.preparedTransaction && row.txHash) {
      await this.deps.queries.markReputationMirrorPreparedConflict({
        paymentId: row.paymentId,
        attestationUid: row.attestationUid,
        transactionHash: row.txHash,
        errorCode: "reputation_ineligible_with_prepared_transaction",
      });
      this.logTerminalReservation(
        row,
        "reputation_ineligible_with_prepared_transaction",
      );
      return;
    }
    await this.deps.queries.markReputationMirrorSkipped({
      paymentId: row.paymentId,
      attestationUid: row.attestationUid,
      errorCode: "reputation_ineligible",
    });
  }

  private async handleFailure(
    claimed: ReputationMirrorRow,
    error: unknown,
  ): Promise<void> {
    if (
      error instanceof ReputationNonceConflictError ||
      error instanceof ReputationStateConflictError
    ) {
      if (error instanceof ReputationNonceConflictError) {
        this.logTerminalReservation(
          claimed,
          "prepared_transaction_nonce_conflict",
        );
      } else {
        logErrorWithId("reputationMirror.stateConflict", error);
      }
      return;
    }
    if (error instanceof FacilitatorOutboxPendingError) {
      await this.deps.queries.deferReputationMirrorForFacilitator(
        claimed.paymentId,
        claimed.attestationUid,
      );
      return;
    }
    const row =
      (await this.deps.queries.getReputationMirror(claimed.paymentId)) ??
      claimed;
    if (error instanceof FeedbackSubmissionError) {
      await this.recordTerminalFailure(row, `feedback_${error.failure}`);
    } else if (
      error instanceof ReputationReceiptPendingError ||
      row.broadcastAt
    ) {
      await this.retry(row, "reputation_receipt_pending", true);
    } else if (row.attempts >= REPUTATION_MIRROR_MAX_ATTEMPTS) {
      await this.recordExhausted(row);
    } else {
      await this.retry(row, "reputation_submission_failed", false);
    }
    logErrorWithId("reputationMirror.process", error, {
      stage: row.broadcastAt ? "receipt" : "submission",
      failureCode:
        error instanceof FeedbackSubmissionError
          ? `feedback_${error.failure}`
          : "reputation_transaction_failed",
      transactionHash: row.txHash,
      paymentId: row.paymentId,
    });
  }

  private async recordTerminalFailure(
    row: ReputationMirrorRow,
    errorCode: string,
  ): Promise<void> {
    if (row.preparedTransaction && row.txHash) {
      await this.deps.queries.finishReputationMirrorTransaction({
        paymentId: row.paymentId,
        attestationUid: row.attestationUid,
        transactionHash: row.txHash,
        outcome: { status: "failed", errorCode },
      });
      return;
    }
    await this.deps.queries.markReputationMirrorUnpreparedFailed({
      paymentId: row.paymentId,
      attestationUid: row.attestationUid,
      errorCode,
    });
  }

  private async recordExhausted(row: ReputationMirrorRow): Promise<void> {
    if (row.preparedTransaction && row.txHash) {
      await this.deps.queries.markReputationMirrorPreparedConflict({
        paymentId: row.paymentId,
        attestationUid: row.attestationUid,
        transactionHash: row.txHash,
        errorCode: "reputation_submission_attempt_limit",
      });
    } else {
      await this.deps.queries.markReputationMirrorUnpreparedFailed({
        paymentId: row.paymentId,
        attestationUid: row.attestationUid,
        errorCode: "reputation_submission_attempt_limit",
      });
    }
    logger.error("reputation mirror submission exhausted", {
      ownerKind: "reputation",
      paymentId: row.paymentId,
      transactionHash: row.txHash,
      transactionNonce: row.transactionNonce,
      attempts: row.attempts,
      failureCode: "reputation_submission_attempt_limit",
    });
  }

  private async retry(
    row: ReputationMirrorRow,
    errorCode: string,
    receiptPending: boolean,
  ): Promise<void> {
    await this.deps.queries.markReputationMirrorRetry({
      paymentId: row.paymentId,
      attestationUid: row.attestationUid,
      transactionHash: row.txHash,
      errorCode,
      receiptPending,
    });
  }

  private logDelayedTransaction(row: ReputationMirrorRow): void {
    const ageMs = Date.now() - (row.preparedAt ?? row.createdAt).getTime();
    if (row.attempts === 4 || ageMs >= 120_000) {
      logger.warn("reputation transaction reconciliation delayed", {
        ownerKind: "reputation",
        paymentId: row.paymentId,
        transactionHash: row.txHash,
        transactionNonce: row.transactionNonce,
        attempts: row.attempts,
        receiptChecks: row.receiptChecks,
        ageMs,
        failureCode: row.lastError ?? "reputation_transaction_delayed",
      });
    }
  }

  private logTerminalReservation(
    row: ReputationMirrorRow,
    failureCode: string,
  ): void {
    logger.error("reputation transaction requires operator reconciliation", {
      ownerKind: "reputation",
      paymentId: row.paymentId,
      transactionHash: row.txHash,
      transactionNonce: row.transactionNonce,
      failureCode,
    });
  }
}
