import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { reputationBytea } from "./reputationRows.js";

const safeCode = (value: string): string => value.slice(0, 128);

export function createReputationTransactionQueries(pool: Pool) {
  return {
    async markReputationMirrorPrepared(input: {
      paymentId: bigint;
      attestationUid: Hex;
      transactionHash: Hex;
      preparedTransaction: Hex;
      transactionNonce: bigint;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'prepared',
                tx_hash = $3,
                prepared_tx = $4,
                tx_nonce = $5,
                prepared_at = now(),
                broadcast_at = NULL,
                receipt_checks = 0,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'
            AND prepared_tx IS NULL`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
          reputationBytea(input.preparedTransaction),
          input.transactionNonce.toString(),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async markReputationMirrorBroadcast(input: {
      paymentId: bigint;
      attestationUid: Hex;
      transactionHash: Hex;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'broadcast',
                broadcast_at = COALESCE(broadcast_at, now()),
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND tx_hash = $3
            AND prepared_tx IS NOT NULL`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async finishReputationMirrorTransaction(input: {
      paymentId: bigint;
      attestationUid: Hex;
      transactionHash: Hex;
      outcome:
        | {
            status: "sent";
            providerAgentId: bigint;
            feedbackIndex: bigint;
          }
        | { status: "failed"; errorCode: string };
    }): Promise<boolean> {
      let providerAgentId: string | null = null;
      let feedbackIndex: string | null = null;
      let errorCode: string | null = null;
      if (input.outcome.status === "sent") {
        providerAgentId = input.outcome.providerAgentId.toString();
        feedbackIndex = input.outcome.feedbackIndex.toString();
      } else {
        errorCode = safeCode(input.outcome.errorCode);
      }
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = CASE
                  WHEN pending_attestation_uid IS NULL THEN $4
                  ELSE 'queued'
                END,
                provider_agent_id = CASE
                  WHEN $4 = 'sent' THEN $5
                  ELSE provider_agent_id
                END,
                feedback_index = CASE
                  WHEN $4 = 'sent' THEN $6
                  ELSE feedback_index
                END,
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
                  WHEN pending_attestation_uid IS NULL THEN $3
                  ELSE NULL
                END,
                prepared_tx = NULL,
                tx_nonce = NULL,
                prepared_at = CASE
                  WHEN pending_attestation_uid IS NULL THEN prepared_at
                  ELSE NULL
                END,
                broadcast_at = CASE
                  WHEN pending_attestation_uid IS NULL THEN broadcast_at
                  ELSE NULL
                END,
                attempts = CASE
                  WHEN pending_attestation_uid IS NULL THEN attempts
                  ELSE 0
                END,
                receipt_checks = CASE
                  WHEN pending_attestation_uid IS NULL THEN receipt_checks
                  ELSE 0
                END,
                next_attempt_at = now(),
                last_error = CASE
                  WHEN pending_attestation_uid IS NOT NULL THEN NULL
                  WHEN $4 = 'failed' THEN $7
                  ELSE NULL
                END,
                pending_attestation_uid = NULL,
                pending_confirmation = NULL,
                pending_ref_uid = NULL,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND tx_hash = $3
            AND prepared_tx IS NOT NULL`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
          input.outcome.status,
          providerAgentId,
          feedbackIndex,
          errorCode,
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async markReputationMirrorPreparedConflict(input: {
      paymentId: bigint;
      attestationUid: Hex;
      transactionHash: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'failed',
                next_attempt_at = now(),
                last_error = $4,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND tx_hash = $3
            AND prepared_tx IS NOT NULL`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          reputationBytea(input.transactionHash),
          safeCode(input.errorCode),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },
  };
}
