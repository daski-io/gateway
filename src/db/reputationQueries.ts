import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import {
  mapReputationMirrorRow,
  REPUTATION_MIRROR_MAX_ATTEMPTS,
  type ReputationMirrorDbRow,
  type ReputationMirrorRow,
} from "./reputationRows.js";

export { REPUTATION_MIRROR_MAX_ATTEMPTS } from "./reputationRows.js";

export function createReputationQueries(pool: Pool) {
  return {
    async getReputationMirror(
      paymentId: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const result = await pool.query<ReputationMirrorDbRow>(
        "SELECT * FROM reputation_mirrors WHERE payment_id = $1",
        [paymentId.toString()],
      );
      return result.rows[0] ? mapReputationMirrorRow(result.rows[0]) : null;
    },

    async claimReputationMirror(
      paymentId?: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const result = await pool.query<ReputationMirrorDbRow>(
        `WITH dead_letter AS (
           UPDATE reputation_mirrors
              SET status = 'failed',
                  last_error = 'reputation_submission_attempt_limit',
                  updated_at = now()
            WHERE attempts >= $2
              AND NOT EXISTS (
                SELECT 1
                  FROM facilitator_transactions AS transaction
                 WHERE transaction.status IN ('prepared', 'broadcast')
                   AND (
                     transaction.id =
                       reputation_mirrors.revoke_facilitator_transaction_id
                     OR transaction.id =
                       reputation_mirrors.give_facilitator_transaction_id
                   )
              )
              AND (
                status IN ('queued', 'retry')
                OR (
                  status = 'processing'
                  AND updated_at < now() - interval '2 minutes'
                )
              )
         ),
         candidate AS (
           SELECT payment_id
             FROM reputation_mirrors
            WHERE ($1::bigint IS NULL OR payment_id = $1)
              AND attempts < $2
              AND NOT EXISTS (
                SELECT 1
                  FROM facilitator_transactions AS transaction
                 WHERE transaction.status IN ('prepared', 'broadcast')
                   AND (
                     transaction.id =
                       reputation_mirrors.revoke_facilitator_transaction_id
                     OR transaction.id =
                       reputation_mirrors.give_facilitator_transaction_id
                   )
              )
              AND (
                (
                  status IN ('queued', 'retry')
                  AND next_attempt_at <= now()
                )
                OR (
                  status = 'processing'
                  AND updated_at < now() - interval '2 minutes'
                )
              )
            ORDER BY next_attempt_at, updated_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE reputation_mirrors AS mirror
            SET status = 'processing',
                attempts = attempts + 1,
                updated_at = now()
           FROM candidate
          WHERE mirror.payment_id = candidate.payment_id
         RETURNING mirror.*`,
        [paymentId?.toString() ?? null, REPUTATION_MIRROR_MAX_ATTEMPTS],
      );
      return result.rows[0] ? mapReputationMirrorRow(result.rows[0]) : null;
    },

    async listMissingReputationMirrors(
      limit = 50,
    ): Promise<
      Array<{ paymentId: bigint; attestationUid: Hex; refUid: Hex | null }>
    > {
      const result = await pool.query<{
        payment_id: string;
        confirmation_attestation_uid: Buffer;
        ref_uid: Buffer | null;
      }>(
        `SELECT challenge.payment_id,
                challenge.confirmation_attestation_uid,
                submission.ref_uid
           FROM payment_challenges AS challenge
           LEFT JOIN reputation_mirrors AS mirror
             ON mirror.payment_id = challenge.payment_id
           LEFT JOIN buyer_confirmation_submissions AS submission
             ON submission.payment_id = challenge.payment_id
            AND submission.attestation_uid =
                  challenge.confirmation_attestation_uid
            AND submission.status = 'confirmed'
          WHERE challenge.settlement_state = 'paid'
            AND challenge.payment_id IS NOT NULL
            AND challenge.confirmation_attestation_uid IS NOT NULL
            AND (
              mirror.payment_id IS NULL
              OR (
                mirror.attestation_uid <>
                  challenge.confirmation_attestation_uid
                AND mirror.pending_attestation_uid IS DISTINCT FROM
                  challenge.confirmation_attestation_uid
              )
            )
          ORDER BY challenge.verified_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        paymentId: BigInt(row.payment_id),
        attestationUid: `0x${row.confirmation_attestation_uid.toString("hex")}`,
        refUid: row.ref_uid ? `0x${row.ref_uid.toString("hex")}` : null,
      }));
    },

    async withProviderFeedbackLock<T>(
      providerAgentId: bigint,
      action: () => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      const key = `daski:feedback:${providerAgentId}`;
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          key,
        ]);
        return await action();
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
          .catch(() => undefined);
        client.release();
      }
    },
  };
}
