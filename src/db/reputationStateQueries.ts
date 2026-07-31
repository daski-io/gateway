import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { reputationBytea } from "./reputationRows.js";

const safeCode = (value: string): string => value.slice(0, 128);

export function createReputationStateQueries(pool: Pool) {
  return {
    async markReputationMirrorRetry(input: {
      paymentId: bigint;
      attestationUid: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'retry',
                next_attempt_at = now() + (
                  interval '1 second' * LEAST(300, power(2, LEAST(8, attempts)))
                ),
                last_error = $3,
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
      return result.rowCount === 1;
    },

    async markReputationMirrorUnpreparedFailed(input: {
      paymentId: bigint;
      attestationUid: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'failed',
                last_error = $3,
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
      return result.rowCount === 1;
    },

    async markReputationMirrorSkipped(input: {
      paymentId: bigint;
      attestationUid: Hex;
      errorCode: string;
    }): Promise<boolean> {
      const result = await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'skipped',
                last_error = $3,
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
          safeCode(input.errorCode),
        ],
      );
      return result.rowCount === 1;
    },

    async deferReputationMirrorForFacilitator(
      paymentId: bigint,
      attestationUid: Hex,
    ): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'retry',
                attempts = GREATEST(0, attempts - 1),
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
