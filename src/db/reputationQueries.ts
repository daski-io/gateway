import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import {
  mapReputationMirrorRow,
  REPUTATION_MIRROR_MAX_ATTEMPTS,
  reputationBytea,
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

    async enqueueReputationMirror(input: {
      paymentId: bigint;
      confirmation: "Confirmed" | "NotConfirmed";
      attestationUid: Hex;
      refUid: Hex | null;
    }): Promise<boolean> {
      const result = await pool.query<{ should_process: boolean }>(
        `INSERT INTO reputation_mirrors
           (payment_id, attestation_uid, confirmation, ref_uid, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT (payment_id) DO UPDATE
         SET attestation_uid = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.attestation_uid
               ELSE EXCLUDED.attestation_uid
             END,
             confirmation = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.confirmation
               ELSE EXCLUDED.confirmation
             END,
             ref_uid = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.ref_uid
               ELSE EXCLUDED.ref_uid
             END,
             pending_attestation_uid = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN EXCLUDED.attestation_uid
               ELSE NULL
             END,
             pending_confirmation = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN EXCLUDED.confirmation
               ELSE NULL
             END,
             pending_ref_uid = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN EXCLUDED.ref_uid
               ELSE NULL
             END,
             status = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.status
               ELSE 'queued'
             END,
             tx_hash = CASE
               WHEN reputation_mirrors.attestation_uid = EXCLUDED.attestation_uid
                 THEN reputation_mirrors.tx_hash
               ELSE NULL
             END,
             attempts = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.attempts
               ELSE 0
             END,
             next_attempt_at = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.next_attempt_at
               ELSE now()
             END,
             last_error = CASE
               WHEN reputation_mirrors.status = 'processing'
                 THEN reputation_mirrors.last_error
               ELSE NULL
             END,
             updated_at = now()
         WHERE reputation_mirrors.attestation_uid <> EXCLUDED.attestation_uid
            OR reputation_mirrors.status NOT IN ('sent', 'skipped')
         RETURNING pending_attestation_uid IS NULL AS should_process`,
        [
          input.paymentId.toString(),
          reputationBytea(input.attestationUid),
          input.confirmation,
          input.refUid ? reputationBytea(input.refUid) : null,
        ],
      );
      return result.rows[0]?.should_process === true;
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
    ): Promise<Array<{ paymentId: bigint; attestationUid: Hex }>> {
      const result = await pool.query<{
        payment_id: string;
        confirmation_attestation_uid: Buffer;
      }>(
        `SELECT challenge.payment_id, challenge.confirmation_attestation_uid
           FROM payment_challenges AS challenge
           LEFT JOIN reputation_mirrors AS mirror
             ON mirror.payment_id = challenge.payment_id
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
