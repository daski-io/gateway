import { ConfirmationSubmitError } from "../chain/confirmationErrors.js";
import type {
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PreparedConfirmationTransaction,
} from "../chain/reader.js";
import type { Queries } from "../db/queries.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { Hex } from "../types.js";
import { FacilitatorTransactionCoordinator } from "./facilitatorTransactionCoordinator.js";

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export async function reconcileBuyerConfirmations(
  reader: ChainReader,
  queries: Queries,
  reputationWorker: ReputationMirrorWorker,
  limit = 50,
): Promise<{ scanned: number; recovered: number }> {
  const due = await queries.listDueFacilitatorTransactions(
    "buyer_confirmation",
    limit,
  );
  let recovered = 0;
  for (const transaction of due) {
    const submission = await queries.getConfirmationSubmissionByHash(
      transaction.intentHash,
    );
    if (
      !submission ||
      submission.facilitatorTransactionId !== transaction.id ||
      (submission.status !== "prepared" && submission.status !== "broadcast")
    ) {
      continue;
    }
    const delegation = delegationFrom(transaction.operationData);
    try {
      const coordinator = new FacilitatorTransactionCoordinator(reader, queries);
      const result = await coordinator.execute<ConfirmationResult>({
        owner: {
          kind: "buyer_confirmation",
          key: submission.requestHash.toLowerCase(),
        },
        intentHash: transaction.intentHash,
        operationData: transaction.operationData,
        prepare: async () => {
          throw new Error("confirmation recovery cannot prepare a replacement");
        },
        send: (prepared, onBroadcast) =>
          reader.submitPreparedBuyerConfirmation(
            prepared as PreparedConfirmationTransaction,
            delegation,
            onBroadcast,
          ),
        inspect: (hash) =>
          reader.getBuyerConfirmationByTransaction(hash, delegation),
        persistPrepared: async () => {
          throw new Error("confirmation recovery cannot replace its link");
        },
        persistBroadcast: (client, id) =>
          queries.markConfirmationSubmissionBroadcast(
            client,
            submission.requestHash,
            id,
          ),
        finalizeSuccess: async (client, id, result) => {
          await queries.finishConfirmationSubmission(
            client,
            submission.requestHash,
            id,
            { status: "confirmed", attestationUid: result.attestationUid },
          );
          await queries.recordConfirmation(
            submission.paymentId,
            result.attestationUid,
            client,
          );
        },
        finalizeReverted: (client, id, code) =>
          queries.finishConfirmationSubmission(
            client,
            submission.requestHash,
            id,
            {
              status:
                code === "prepared_transaction_nonce_conflict"
                  ? "nonce_conflict"
                  : "reverted",
            },
          ),
        isReverted: (error) =>
          error instanceof ConfirmationSubmitError &&
          error.stage === "reverted",
        failureCode: () => "confirmation_transaction_reverted",
      });
      await reputationWorker.enqueue({
        paymentId: submission.paymentId,
        confirmation: submission.confirmation,
        attestationUid: result.attestationUid,
        refUid: submission.refUid,
      });
      recovered += 1;
    } catch {
      // The durable journal schedules the next bounded reconciliation pass.
    }
  }
  return { scanned: due.length, recovered };
}

function delegationFrom(
  data: Record<string, unknown>,
): ConfirmationDelegationInput {
  return {
    attester: requiredHex(data.attester, "attester"),
    schema: requiredHex(data.schema, "schema"),
    recipient: requiredHex(data.recipient, "recipient"),
    expirationTime: 0n,
    revocable: true,
    refUID: requiredHex(data.refUid, "refUid"),
    data: "0x",
    value: 0n,
    deadline: 0n,
    signature: { v: 0, r: ZERO_HASH, s: ZERO_HASH },
  };
}

function requiredHex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`confirmation journal is missing ${field}`);
  }
  return value as Hex;
}
