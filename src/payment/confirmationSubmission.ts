import { randomUUID } from "node:crypto";
import { ConfirmationSubmitError } from "../chain/confirmationErrors.js";
import type {
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PreparedConfirmationTransaction,
} from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { Hex } from "../types.js";
import {
  FacilitatorTransactionCoordinator,
} from "./facilitatorTransactionCoordinator.js";
import {
  ConfirmationAdmissionError,
  confirmationSponsorshipError,
  validateConfirmationRevision,
  verifyConfirmationSignature,
} from "./confirmationAdmission.js";
import {
  confirmationPayload,
  confirmationRequestHash,
  type ConfirmInput,
} from "./confirmationRequest.js";
export { ConfirmationAdmissionError } from "./confirmationAdmission.js";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export interface ConfirmationSubmissionDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
  reputationWorker: ReputationMirrorWorker;
}

export async function submitConfirmation(
  deps: ConfirmationSubmissionDeps,
  paymentId: bigint,
  input: ConfirmInput,
): Promise<ConfirmationResult & { requestHash: Hex }> {
  if (input.deadline < BigInt(Math.floor(Date.now() / 1000) + 120)) {
    throw new ConfirmationAdmissionError(
      "confirmation_signature_expiring",
      400,
    );
  }
  const [payment, reputation] = await Promise.all([
    deps.reader.getPaymentRecord(paymentId),
    deps.reader.getReputationRecord(paymentId),
  ]);
  if (!payment) {
    throw new ConfirmationAdmissionError("unknown_payment", 404);
  }
  if (
    payment.cachedBuyerWallet === ZERO_ADDRESS ||
    payment.cachedBuyerWallet.toLowerCase() !== input.attester.toLowerCase()
  ) {
    throw new ConfirmationAdmissionError("confirmation_attester_mismatch", 403);
  }
  const recipient =
    payment.cachedProviderWallet === ZERO_ADDRESS
      ? payment.cachedProviderOwner
      : payment.cachedProviderWallet;
  const refUID = input.refUid ?? ZERO_BYTES32;
  const data = confirmationPayload(paymentId, input.confirmation);
  await verifyConfirmationSignature(
    deps.config,
    input,
    recipient,
    refUID,
    data,
  );
  const requestHash = confirmationRequestHash({
    paymentId,
    confirmation: input.confirmation,
    attester: input.attester,
    recipient,
    easNonce: input.easNonce,
    schema: deps.config.easConfirmationSchemaUid,
    refUid: refUID,
    data,
    deadline: input.deadline,
    signature: input.signature,
  });
  const [exact, activePayment, activeNonce] = await Promise.all([
    deps.queries.getConfirmationSubmissionByHash(requestHash),
    deps.queries.getActiveConfirmationSubmission(paymentId),
    deps.queries.getActiveConfirmationSubmissionByNonce(
      input.attester,
      input.easNonce,
    ),
  ]);
  if (
    [activePayment, activeNonce].some(
      (active) =>
        active &&
        active.requestHash.toLowerCase() !== requestHash.toLowerCase(),
    )
  ) {
    throw new ConfirmationAdmissionError(
      "confirmation_reconciliation_pending",
      503,
      true,
    );
  }
  if (!exact) {
    validateConfirmationRevision(
      reputation?.currentConfirmationUid ?? ZERO_BYTES32,
      input,
    );
    const currentNonce = await deps.reader.getEasAttesterNonce(input.attester);
    if (currentNonce !== input.easNonce) {
      throw new ConfirmationAdmissionError("confirmation_nonce_stale", 409);
    }
    const submissionCount =
      await deps.queries.countConfirmationSubmissions(paymentId);
    if (submissionCount >= deps.config.confirmationMaxPerPayment) {
      throw new ConfirmationAdmissionError(
        "confirmation_revision_limit",
        409,
      );
    }
  }
  const delegation: ConfirmationDelegationInput = {
    attester: input.attester,
    schema: deps.config.easConfirmationSchemaUid,
    recipient,
    expirationTime: 0n,
    revocable: true,
    refUID,
    data,
    value: 0n,
    deadline: input.deadline,
    signature: input.signature,
  };
  const submissionId = exact?.id ?? randomUUID();
  const coordinator = new FacilitatorTransactionCoordinator(
    deps.reader,
    deps.queries,
  );
  const result = await coordinator.execute<ConfirmationResult>({
    owner: { kind: "buyer_confirmation", key: requestHash.toLowerCase() },
    intentHash: requestHash,
    operationData: {
      paymentId: paymentId.toString(),
      confirmation: input.confirmation,
      attester: input.attester,
      easNonce: input.easNonce.toString(),
      recipient,
      schema: deps.config.easConfirmationSchemaUid,
      refUid: refUID,
    },
    prepare: (nonce) => deps.reader.prepareBuyerConfirmation(delegation, nonce),
    send: (prepared, onBroadcast) =>
      deps.reader.submitPreparedBuyerConfirmation(
        prepared as PreparedConfirmationTransaction,
        delegation,
        onBroadcast,
      ),
    inspect: (hash) =>
      deps.reader.getBuyerConfirmationByTransaction(hash, delegation),
    loadCompleted: async () => {
      const submission =
        await deps.queries.getConfirmationSubmissionByHash(requestHash);
      if (!submission?.attestationUid || !submission.facilitatorTransactionId) {
        return null;
      }
      const transaction = await deps.queries.getFacilitatorTransactionById(
        submission.facilitatorTransactionId,
      );
      return transaction
        ? {
            transactionHash: transaction.transactionHash,
            attestationUid: submission.attestationUid,
          }
        : null;
    },
    persistPrepared: async (client, transactionId) => {
      const limit = await deps.queries.reserveConfirmationSubmission(client, {
        id: submissionId,
        paymentId,
        attester: input.attester,
        easAttesterNonce: input.easNonce,
        confirmation: input.confirmation,
        refUid: input.refUid,
        requestHash,
        facilitatorTransactionId: transactionId,
        paymentLimit: deps.config.confirmationMaxPerPayment,
        walletDailyLimit: deps.config.confirmationMaxPerWalletPerDay,
        globalDailyLimit: deps.config.confirmationMaxGlobalPerDay,
      });
      if (limit) throw confirmationSponsorshipError(limit);
    },
    persistBroadcast: (client, transactionId) =>
      deps.queries.markConfirmationSubmissionBroadcast(
        client,
        requestHash,
        transactionId,
      ),
    finalizeSuccess: async (client, transactionId, confirmation) => {
      await deps.queries.finishConfirmationSubmission(
        client,
        requestHash,
        transactionId,
        { status: "confirmed", attestationUid: confirmation.attestationUid },
      );
      await deps.queries.recordConfirmation(
        paymentId,
        confirmation.attestationUid,
        client,
      );
    },
    finalizeReverted: (client, transactionId, failureCode) =>
      deps.queries.finishConfirmationSubmission(
        client,
        requestHash,
        transactionId,
        {
          status:
            failureCode === "prepared_transaction_nonce_conflict"
              ? "nonce_conflict"
              : "reverted",
        },
      ),
    isReverted: (error) =>
      error instanceof ConfirmationSubmitError && error.stage === "reverted",
    failureCode: () => "confirmation_transaction_reverted",
    allowNewAttemptAfterRevert: false,
  });
  await deps.reputationWorker.enqueue({
    paymentId,
    confirmation: input.confirmation,
    attestationUid: result.attestationUid,
    refUid: input.refUid,
  });
  return { ...result, requestHash };
}
