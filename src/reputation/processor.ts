import {
  FeedbackAlreadyRevokedError,
  FeedbackSubmissionError,
} from "../chain/feedbackErrors.js";
import type {
  ChainReader,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
} from "../chain/reader.js";
import type { Config } from "../config.js";
import { FacilitatorTransactionPendingError } from "../db/facilitatorLockQueries.js";
import { ReputationProjectionMismatchError } from "../db/reputationTransactionQueries.js";
import type { Queries, ReputationMirrorRow } from "../db/queries.js";
import { REPUTATION_MIRROR_MAX_ATTEMPTS } from "../db/reputationQueries.js";
import {
  FacilitatorTransactionCoordinator,
  FacilitatorTransactionTerminalError,
} from "../payment/facilitatorTransactionCoordinator.js";
import { hashCanonical } from "../payment/requirementResponse.js";
import { requireFacilitatorBalance } from "../payment/facilitatorBalance.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { logger } from "../util/logger.js";
import { buildFeedbackInput } from "./mirror.js";

export interface ReputationMirrorWorkerDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
}

export class ReputationMirrorProcessor {
  constructor(private readonly deps: ReputationMirrorWorkerDeps) {}

  async process(row: ReputationMirrorRow): Promise<void> {
    try {
      const [record, challenge] = await Promise.all([
        this.deps.reader.getPaymentRecord(row.paymentId),
        this.deps.queries.getChallengeByPaymentId(row.paymentId),
      ]);
      if (!record) throw new Error("authoritative payment record not found");
      if (!record.reputationEligible) {
        await this.deps.queries.markReputationMirrorSkipped({
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          errorCode: "reputation_ineligible",
        });
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
        async () => {
          await this.revokePriorFeedback(row, record.providerAgentId);
          await this.giveFeedback(row, feedback, record.providerAgentId);
        },
      );
    } catch (error) {
      await this.handleFailure(row, error);
    }
  }

  private async revokePriorFeedback(
    row: ReputationMirrorRow,
    providerAgentId: bigint,
  ): Promise<void> {
    if (row.feedbackIndex == null) return;
    const input = {
      agentId: row.providerAgentId ?? providerAgentId,
      feedbackIndex: row.feedbackIndex,
    };
    const intentHash = hashCanonical({
      agentId: input.agentId.toString(),
      feedbackIndex: input.feedbackIndex.toString(),
    });
    const coordinator = new FacilitatorTransactionCoordinator(
      this.deps.reader,
      this.deps.queries,
    );
    try {
      await coordinator.execute<FeedbackResult>({
        owner: {
          kind: "feedback_revoke",
          key: `${input.agentId}:${input.feedbackIndex}`,
        },
        intentHash,
        operationData: {
          paymentId: row.paymentId.toString(),
          attestationUid: row.attestationUid,
          agentId: input.agentId.toString(),
          feedbackIndex: input.feedbackIndex.toString(),
        },
        prepare: (nonce) =>
          this.deps.reader.prepareFeedbackRevocation(input, nonce),
        send: async (prepared, onBroadcast) => {
          await this.requireFacilitatorBalance();
          return this.deps.reader.submitPreparedFeedbackRevocation(
            prepared as PreparedFeedbackTransaction,
            input,
            onBroadcast,
          );
        },
        inspect: (hash) =>
          this.deps.reader.getFeedbackRevocationByTransaction(hash, input),
        persistPrepared: (client, transactionId) =>
          this.deps.queries.linkReputationFacilitatorTransaction(client, {
            paymentId: row.paymentId,
            attestationUid: row.attestationUid,
            kind: "revoke",
            transactionId,
          }),
        finalizeSuccess: (client, transactionId) =>
          this.deps.queries.finishReputationRevocationSuccess(client, {
            paymentId: row.paymentId,
            attestationUid: row.attestationUid,
            transactionId,
          }),
        finalizeReverted: (client, transactionId) =>
          this.deps.queries.finishReputationMirrorFailure(client, {
            paymentId: row.paymentId,
            attestationUid: row.attestationUid,
            errorCode: "feedback_revoke_reverted",
            transactionId,
            kind: "revoke",
          }),
        isReverted: isFeedbackRevert,
        failureCode: () => "feedback_revoke_reverted",
        projectionFailureCode,
      });
    } catch (error) {
      if (error instanceof FeedbackAlreadyRevokedError) return;
      throw error;
    }
  }

  private async giveFeedback(
    row: ReputationMirrorRow,
    input: FeedbackInput,
    providerAgentId: bigint,
  ): Promise<void> {
    const intentHash = hashCanonical({
      ...input,
      agentId: input.agentId.toString(),
      value: input.value.toString(),
    });
    const coordinator = new FacilitatorTransactionCoordinator(
      this.deps.reader,
      this.deps.queries,
    );
    await coordinator.execute<FeedbackResult>({
      owner: {
        kind: "feedback_give",
        key: `${row.paymentId}:${row.attestationUid.toLowerCase()}`,
      },
      intentHash,
      operationData: {
        paymentId: row.paymentId.toString(),
        attestationUid: row.attestationUid,
        input: {
          ...input,
          agentId: input.agentId.toString(),
          value: input.value.toString(),
        },
      },
      prepare: (nonce) => this.deps.reader.prepareFeedback(input, nonce),
      send: async (prepared, onBroadcast) => {
        await this.requireFacilitatorBalance();
        return this.deps.reader.submitPreparedFeedback(
          prepared as PreparedFeedbackTransaction,
          input,
          onBroadcast,
        );
      },
      inspect: (hash) =>
        this.deps.reader.getFeedbackByTransaction(hash, input),
      persistPrepared: (client, transactionId) =>
        this.deps.queries.linkReputationFacilitatorTransaction(client, {
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          kind: "give",
          transactionId,
        }),
      finalizeSuccess: async (client, transactionId, result) => {
        if (result.feedbackIndex == null) {
          throw new FeedbackSubmissionError(
            "malformed_event",
            "NewFeedback event omitted feedbackIndex",
          );
        }
        await this.deps.queries.finishReputationMirrorSuccess(client, {
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          transactionHash: result.transactionHash,
          providerAgentId,
          feedbackIndex: result.feedbackIndex,
          transactionId,
        });
      },
      finalizeReverted: (client, transactionId) =>
        this.deps.queries.finishReputationMirrorFailure(client, {
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          errorCode: "feedback_give_reverted",
          transactionId,
          kind: "give",
        }),
      isReverted: isFeedbackRevert,
      failureCode: () => "feedback_give_reverted",
      projectionFailureCode,
    });
  }

  private requireFacilitatorBalance(): Promise<void> {
    return requireFacilitatorBalance(
      this.deps.reader,
      this.deps.config.facilitatorMinBalanceWei,
      this.deps.config.facilitatorMaxTransactionFeeWei,
    );
  }

  private async handleFailure(
    row: ReputationMirrorRow,
    error: unknown,
  ): Promise<void> {
    if (error instanceof FacilitatorTransactionPendingError) {
      await this.deps.queries.deferReputationMirrorForFacilitator(
        row.paymentId,
        row.attestationUid,
      );
      return;
    }
    if (error instanceof ReputationProjectionMismatchError) {
      logger.error("reputation journal projection mismatch", {
        paymentId: row.paymentId,
        failureCode: "reputation_projection_mismatch",
      });
      return;
    }
    if (
      error instanceof FacilitatorTransactionTerminalError ||
      (error instanceof FeedbackSubmissionError &&
        error.failure === "reverted")
    ) {
      return;
    }
    if (row.attempts >= REPUTATION_MIRROR_MAX_ATTEMPTS) {
      await this.deps.queries.markReputationMirrorUnpreparedFailed({
        paymentId: row.paymentId,
        attestationUid: row.attestationUid,
        errorCode: "reputation_submission_attempt_limit",
      });
      logger.error("reputation mirror submission exhausted", {
        paymentId: row.paymentId,
        failureCode: "reputation_submission_attempt_limit",
      });
      return;
    }
    await this.deps.queries.markReputationMirrorRetry({
      paymentId: row.paymentId,
      attestationUid: row.attestationUid,
      errorCode: "reputation_transaction_failed",
    });
    logErrorWithId("reputationMirror.process", error, {
      paymentId: row.paymentId,
      failureCode: "reputation_transaction_failed",
    });
  }
}

function isFeedbackRevert(error: unknown): boolean {
  return (
    error instanceof FeedbackSubmissionError &&
    error.failure === "reverted"
  );
}

function projectionFailureCode(error: unknown): string | null {
  return error instanceof ReputationProjectionMismatchError
    ? "reputation_projection_mismatch"
    : null;
}
