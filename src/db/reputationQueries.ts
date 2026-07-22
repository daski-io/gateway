import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

export type ReputationMirrorStatus =
  | "queued"
  | "processing"
  | "prepared"
  | "broadcast"
  | "retry"
  | "sent"
  | "failed"
  | "skipped";

interface ReputationMirrorDbRow {
  payment_id: string;
  attestation_uid: Buffer;
  provider_agent_id: string | null;
  feedback_index: string | null;
  tx_hash: Buffer | null;
  status: ReputationMirrorStatus;
  confirmation: "Confirmed" | "NotConfirmed" | null;
  ref_uid: Buffer | null;
  prepared_tx: Buffer | null;
  tx_nonce: string | null;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReputationMirrorRow {
  paymentId: bigint;
  attestationUid: Hex;
  providerAgentId: bigint | null;
  feedbackIndex: bigint | null;
  txHash: Hex | null;
  status: ReputationMirrorStatus;
  confirmation: "Confirmed" | "NotConfirmed" | null;
  refUid: Hex | null;
  preparedTransaction: Hex | null;
  transactionNonce: bigint | null;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const bytea = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

function mapRow(row: ReputationMirrorDbRow): ReputationMirrorRow {
  return {
    paymentId: BigInt(row.payment_id),
    attestationUid: hex(row.attestation_uid),
    providerAgentId:
      row.provider_agent_id == null ? null : BigInt(row.provider_agent_id),
    feedbackIndex:
      row.feedback_index == null ? null : BigInt(row.feedback_index),
    txHash: row.tx_hash ? hex(row.tx_hash) : null,
    status: row.status,
    confirmation: row.confirmation,
    refUid: row.ref_uid ? hex(row.ref_uid) : null,
    preparedTransaction: row.prepared_tx ? hex(row.prepared_tx) : null,
    transactionNonce: row.tx_nonce == null ? null : BigInt(row.tx_nonce),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createReputationQueries(pool: Pool) {
  return {
    async getReputationMirror(
      paymentId: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const result = await pool.query<ReputationMirrorDbRow>(
        "SELECT * FROM reputation_mirrors WHERE payment_id = $1",
        [paymentId.toString()],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async enqueueReputationMirror(input: {
      paymentId: bigint;
      confirmation: "Confirmed" | "NotConfirmed";
      attestationUid: Hex;
      refUid: Hex | null;
    }): Promise<boolean> {
      const result = await pool.query(
        `INSERT INTO reputation_mirrors
           (payment_id, attestation_uid, confirmation, ref_uid, status)
         VALUES ($1, $2, $3, $4, 'queued')
         ON CONFLICT (payment_id) DO UPDATE
         SET attestation_uid = EXCLUDED.attestation_uid,
             confirmation = EXCLUDED.confirmation,
             ref_uid = EXCLUDED.ref_uid,
             status = 'queued',
             prepared_tx = NULL,
             tx_nonce = NULL,
             tx_hash = CASE
               WHEN reputation_mirrors.attestation_uid = EXCLUDED.attestation_uid
                 THEN reputation_mirrors.tx_hash
               ELSE NULL
             END,
             attempts = 0,
             next_attempt_at = now(),
             last_error = NULL,
             updated_at = now()
         WHERE reputation_mirrors.attestation_uid <> EXCLUDED.attestation_uid
            OR reputation_mirrors.status NOT IN ('sent', 'skipped')`,
        [
          input.paymentId.toString(),
          bytea(input.attestationUid),
          input.confirmation,
          input.refUid ? bytea(input.refUid) : null,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async claimReputationMirror(
      paymentId?: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const result = await pool.query<ReputationMirrorDbRow>(
        `WITH candidate AS (
           SELECT payment_id
             FROM reputation_mirrors
            WHERE ($1::bigint IS NULL OR payment_id = $1)
              AND (
                (status IN ('queued', 'prepared', 'broadcast', 'retry')
                  AND next_attempt_at <= now())
                OR (status = 'processing'
                  AND updated_at < now() - interval '2 minutes')
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
        [paymentId?.toString() ?? null],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async markReputationMirrorPrepared(input: {
      paymentId: bigint;
      transactionHash: Hex;
      preparedTransaction: Hex;
      transactionNonce: bigint;
    }): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'prepared', tx_hash = $2, prepared_tx = $3,
                tx_nonce = $4, updated_at = now()
          WHERE payment_id = $1`,
        [
          input.paymentId.toString(),
          bytea(input.transactionHash),
          bytea(input.preparedTransaction),
          input.transactionNonce.toString(),
        ],
      );
    },

    async markReputationMirrorBroadcast(
      paymentId: bigint,
      transactionHash: Hex,
    ): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'broadcast', tx_hash = $2, updated_at = now()
          WHERE payment_id = $1`,
        [paymentId.toString(), bytea(transactionHash)],
      );
    },

    async markReputationMirrorSent(input: {
      paymentId: bigint;
      providerAgentId: bigint;
      feedbackIndex: bigint;
      transactionHash: Hex;
    }): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = 'sent', provider_agent_id = $2,
                feedback_index = $3, tx_hash = $4, prepared_tx = NULL,
                tx_nonce = NULL, last_error = NULL, updated_at = now()
          WHERE payment_id = $1`,
        [
          input.paymentId.toString(),
          input.providerAgentId.toString(),
          input.feedbackIndex.toString(),
          bytea(input.transactionHash),
        ],
      );
    },

    async markReputationMirrorResult(input: {
      paymentId: bigint;
      status: "retry" | "failed" | "skipped";
      error?: string;
      clearPrepared?: boolean;
    }): Promise<void> {
      await pool.query(
        `UPDATE reputation_mirrors
            SET status = $2,
                next_attempt_at = CASE WHEN $2 = 'retry'
                  THEN now() + (
                    interval '1 second' *
                    LEAST(300, power(2, LEAST(8, attempts)))
                  )
                  ELSE now()
                END,
                last_error = $3,
                prepared_tx = CASE WHEN $4 THEN NULL ELSE prepared_tx END,
                tx_nonce = CASE WHEN $4 THEN NULL ELSE tx_nonce END,
                tx_hash = CASE WHEN $4 THEN NULL ELSE tx_hash END,
                updated_at = now()
          WHERE payment_id = $1`,
        [
          input.paymentId.toString(),
          input.status,
          input.error?.slice(0, 2000) ?? null,
          input.clearPrepared ?? false,
        ],
      );
    },

    async listMissingReputationMirrors(limit = 50): Promise<
      Array<{ paymentId: bigint; attestationUid: Hex }>
    > {
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
              OR mirror.attestation_uid <> challenge.confirmation_attestation_uid
            )
          ORDER BY challenge.verified_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        paymentId: BigInt(row.payment_id),
        attestationUid: hex(row.confirmation_attestation_uid),
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
