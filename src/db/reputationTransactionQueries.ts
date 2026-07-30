import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { reputationBytea } from "./reputationRows.js";

const safeCode = (value: string): string => value.slice(0, 128);

export function createReputationTransactionQueries(_pool: Pool) {
  return {
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

    async finishReputationMirrorSuccess(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        transactionHash: Hex;
        providerAgentId: bigint;
        feedbackIndex: bigint;
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
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
          input.providerAgentId.toString(),
          input.feedbackIndex.toString(),
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("reputation success finalization conflict");
      }
    },

    async finishReputationMirrorFailure(
      client: PoolClient,
      input: {
        paymentId: bigint;
        attestationUid: Hex;
        errorCode: string;
      },
    ): Promise<void> {
      const result = await client.query(
        `UPDATE reputation_mirrors
            SET status = 'failed',
                last_error = $3,
                next_attempt_at = now(),
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          safeCode(input.errorCode),
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("reputation failure finalization conflict");
      }
    },
  };
}
