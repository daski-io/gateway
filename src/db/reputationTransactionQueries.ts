import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import {
  mapReputationMirrorRow,
  reputationBytea,
  type ReputationMirrorDbRow,
  type ReputationMirrorRow,
} from "./reputationRows.js";

const safeCode = (value: string): string => value.slice(0, 128);

export class ReputationProjectionMismatchError extends Error {
  constructor() {
    super("reputation journal outcome could not be projected to its mirror");
    this.name = "ReputationProjectionMismatchError";
  }
}

export function createReputationTransactionQueries(pool: Pool) {
  return {
    async claimReputationMirrorForTransaction(input: {
      transactionId: string;
      paymentId: bigint;
      attestationUid: Hex;
      kind: "revoke" | "give";
    }): Promise<ReputationMirrorRow | null> {
      const column =
        input.kind === "revoke"
          ? "revoke_facilitator_transaction_id"
          : "give_facilitator_transaction_id";
      const operationKind =
        input.kind === "revoke" ? "feedback_revoke" : "feedback_give";
      const result = await pool.query<ReputationMirrorDbRow>(
        `UPDATE reputation_mirrors AS mirror
            SET status = 'processing',
                updated_at = now()
          WHERE mirror.payment_id = $1::bigint
            AND mirror.attestation_uid = $2
            AND mirror.${column} = $3
            AND EXISTS (
              SELECT 1
                FROM facilitator_transactions AS transaction
               WHERE transaction.id = $3
                 AND transaction.status IN ('prepared', 'broadcast')
                 AND transaction.operation_kind = $4
                 AND transaction.operation_data->>'paymentId' = $1::text
                 AND lower(transaction.operation_data->>'attestationUid') =
                     lower($5)
            )
         RETURNING mirror.*`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          input.transactionId,
          operationKind,
          input.attestationUid,
        ],
      );
      return result.rows[0] ? mapReputationMirrorRow(result.rows[0]) : null;
    },

    async flagReputationJournalIntegrity(
      transactionId: string,
      failureCode: string,
    ): Promise<void> {
      await pool.query(
        `UPDATE facilitator_transactions
            SET failure_code = $2,
                updated_at = now()
          WHERE id = $1
            AND status IN ('prepared', 'broadcast')`,
        [transactionId, safeCode(failureCode)],
      );
    },

    async linkReputationFacilitatorTransaction(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        kind: "revoke" | "give";
        transactionId: string;
      },
    ): Promise<void> {
      const column =
        input.kind === "revoke"
          ? "revoke_facilitator_transaction_id"
          : "give_facilitator_transaction_id";
      const result = await client.query(
        `UPDATE reputation_mirrors
            SET ${column} = $3, updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          input.transactionId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("reputation transaction link conflict");
      }
    },

    async finishReputationRevocationSuccess(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        transactionId: string;
      },
    ): Promise<void> {
      const result = await client.query(
        `UPDATE reputation_mirrors
            SET revoke_facilitator_transaction_id = NULL,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'
            AND revoke_facilitator_transaction_id = $3`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          input.transactionId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ReputationProjectionMismatchError();
      }
    },

    async finishReputationMirrorSuccess(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        transactionHash: Hex;
        providerAgentId: bigint;
        feedbackIndex: bigint;
        transactionId: string;
      },
    ): Promise<void> {
      const result = await client.query(
        `UPDATE reputation_mirrors
            SET status = CASE
                  WHEN pending_attestation_uid IS NULL THEN 'sent'
                  ELSE 'queued'
                END,
                provider_agent_id = $4::bigint,
                feedback_index = $5::bigint,
                attestation_uid = COALESCE(
                  pending_attestation_uid,
                  attestation_uid
                ),
                confirmation = COALESCE(
                  pending_confirmation,
                  confirmation
                ),
                ref_uid = CASE
                  WHEN pending_attestation_uid IS NULL THEN ref_uid
                  ELSE pending_ref_uid
                END,
                tx_hash = CASE
                  WHEN pending_attestation_uid IS NULL THEN $3::bytea
                  ELSE NULL
                END,
                attempts = CASE
                  WHEN pending_attestation_uid IS NULL THEN attempts
                  ELSE 0
                END,
                next_attempt_at = now(),
                last_error = NULL,
                pending_attestation_uid = NULL,
                pending_confirmation = NULL,
                pending_ref_uid = NULL,
                give_facilitator_transaction_id = NULL,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'
            AND give_facilitator_transaction_id = $6`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
          input.providerAgentId.toString(),
          input.feedbackIndex.toString(),
          input.transactionId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ReputationProjectionMismatchError();
      }
    },

    async finishReputationMirrorFailure(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        errorCode: string;
        transactionId: string;
        kind: "revoke" | "give";
      },
    ): Promise<void> {
      const column =
        input.kind === "revoke"
          ? "revoke_facilitator_transaction_id"
          : "give_facilitator_transaction_id";
      const result = await client.query(
        `UPDATE reputation_mirrors
            SET status = 'failed',
                last_error = $3,
                next_attempt_at = now(),
                ${column} = NULL,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'
            AND ${column} = $4`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          safeCode(input.errorCode),
          input.transactionId,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ReputationProjectionMismatchError();
      }
    },
  };
}
