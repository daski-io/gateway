import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { reputationBytea } from "./reputationRows.js";

const safeCode = (value: string): string => value.slice(0, 128);

export function createReputationStateQueries(pool: Pool) {
  return {
    async markReputationMirrorRetry(input: {
      paymentId: bigint;
      attestationUid: Hex;
      transactionHash: Hex | null;
      errorCode: string;
      receiptPending: boolean;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = CASE WHEN $5 THEN 'broadcast' ELSE 'retry' END,
                next_attempt_at = now() + (
                  interval '1 second' * LEAST(
                    300,
                    power(
                      2,
                      LEAST(8, CASE WHEN $5 THEN receipt_checks ELSE attempts END)
                    )
                  )
                ),
                last_error = $4,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND tx_hash IS NOT DISTINCT FROM $3
            AND (
              ($5 AND broadcast_at IS NOT NULL)
              OR (NOT $5 AND broadcast_at IS NULL)
            )
            AND (
              ($5 AND status IN ('processing', 'broadcast'))
              OR (
                NOT $5
                AND status IN ('processing', 'prepared', 'retry')
              )
            )`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          input.transactionHash
            ? reputationBytea(input.transactionHash)
            : null,
          safeCode(input.errorCode),
          input.receiptPending,
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async markReputationMirrorUnpreparedFailed(input: {
      paymentId: bigint;
      attestationUid: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'failed',
                next_attempt_at = now(),
                last_error = $3,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND prepared_tx IS NULL
            AND status = 'processing'`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          safeCode(input.errorCode),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async markReputationMirrorSkipped(input: {
      paymentId: bigint;
      attestationUid: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'skipped',
                next_attempt_at = now(),
                last_error = $3,
                pending_attestation_uid = NULL,
                pending_confirmation = NULL,
                pending_ref_uid = NULL,
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND prepared_tx IS NULL
            AND status = 'processing'`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          safeCode(input.errorCode),
        ],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async deferReputationMirrorForFacilitator(
      paymentId: bigint,
      attestationUid: Hex,
    ): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = CASE
                  WHEN broadcast_at IS NULL THEN 'retry'
                  ELSE 'broadcast'
                END,
                attempts = CASE
                  WHEN broadcast_at IS NULL THEN GREATEST(0, attempts - 1)
                  ELSE attempts
                END,
                receipt_checks = CASE
                  WHEN broadcast_at IS NULL THEN receipt_checks
                  ELSE GREATEST(0, receipt_checks - 1)
                END,
                next_attempt_at = now() + interval '5 seconds',
                last_error = 'facilitator_transaction_reserved',
                updated_at = now()
          WHERE payment_id = $1
            AND attestation_uid = $2
            AND status = 'processing'`,
        [paymentId.toString(), reputationBytea(attestationUid)],
      );
    },
  };
}
