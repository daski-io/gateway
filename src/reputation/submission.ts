import type {
  ChainReader,
  FeedbackInput,
  FeedbackResult,
  PreparedFeedbackTransaction,
} from "../chain/reader.js";
import type { Queries, ReputationMirrorRow } from "../db/queries.js";

export class ReputationReceiptPendingError extends Error {
  constructor() {
    super("reputation transaction receipt is pending");
    this.name = "ReputationReceiptPendingError";
  }
}

export class ReputationNonceConflictError extends Error {
  constructor() {
    super("reputation transaction nonce requires reconciliation");
    this.name = "ReputationNonceConflictError";
  }
}

export class ReputationStateConflictError extends Error {
  constructor() {
    super("reputation transaction state changed concurrently");
    this.name = "ReputationStateConflictError";
  }
}

export async function submitReputationFeedback(
  queries: Queries,
  reader: ChainReader,
  row: ReputationMirrorRow,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  return queries.withFacilitatorTransactionLock(
    async (release) => {
      let prepared = preparedFromRow(row);
      if (prepared) {
        const recovered = await reader.getFeedbackByTransaction(
          prepared.transactionHash,
          input,
        );
        if (recovered) {
          await release();
          return recovered;
        }
        const nextNonce = await reader.getFacilitatorTransactionCount();
        if (nextNonce > prepared.nonce) {
          await queries.markReputationMirrorPreparedConflict({
            paymentId: row.paymentId,
            attestationUid: row.attestationUid,
            transactionHash: prepared.transactionHash,
            errorCode: "prepared_transaction_nonce_conflict",
          });
          throw new ReputationNonceConflictError();
        }
        if (row.broadcastAt) throw new ReputationReceiptPendingError();
      } else {
        prepared = await reader.prepareFeedback(input);
        const persisted = await queries.markReputationMirrorPrepared({
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          transactionHash: prepared.transactionHash,
          preparedTransaction: prepared.serializedTransaction,
          transactionNonce: prepared.nonce,
        });
        if (!persisted) throw new ReputationStateConflictError();
      }
      return reader.submitPreparedFeedback(prepared, input, async (hash) => {
        const persisted = await queries.markReputationMirrorBroadcast({
          paymentId: row.paymentId,
          attestationUid: row.attestationUid,
          transactionHash: hash,
        });
        if (!persisted) throw new ReputationStateConflictError();
        await release();
      });
    },
    {
      owner: {
        kind: "reputation",
        paymentId: row.paymentId,
      },
    },
  );
}

function preparedFromRow(
  row: ReputationMirrorRow,
): PreparedFeedbackTransaction | null {
  if (!row.preparedTransaction || !row.txHash || row.transactionNonce == null) {
    return null;
  }
  return {
    serializedTransaction: row.preparedTransaction,
    transactionHash: row.txHash,
    nonce: row.transactionNonce,
  };
}
