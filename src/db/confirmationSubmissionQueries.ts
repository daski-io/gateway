import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import type {
  ConfirmationSponsorshipLimit,
  ConfirmationSubmissionRow,
} from "./confirmationSubmissionTypes.js";

interface DbRow {
  id: string;
  payment_id: string;
  attester: Buffer;
  eas_attester_nonce: string;
  confirmation: ConfirmationSubmissionRow["confirmation"];
  ref_uid: Buffer | null;
  request_hash: Buffer;
  facilitator_transaction_id: string | null;
  attestation_uid: Buffer | null;
  status: ConfirmationSubmissionRow["status"];
  created_at: Date;
}

const bytea = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

function mapRow(row: DbRow): ConfirmationSubmissionRow {
  return {
    id: row.id,
    paymentId: BigInt(row.payment_id),
    attester: hex(row.attester),
    easAttesterNonce: BigInt(row.eas_attester_nonce),
    confirmation: row.confirmation,
    refUid: row.ref_uid ? hex(row.ref_uid) : null,
    requestHash: hex(row.request_hash),
    facilitatorTransactionId: row.facilitator_transaction_id,
    attestationUid: row.attestation_uid ? hex(row.attestation_uid) : null,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createConfirmationSubmissionQueries(pool: Pool) {
  return {
    async getConfirmationSubmissionByHash(
      requestHash: Hex,
    ): Promise<ConfirmationSubmissionRow | null> {
      const result = await pool.query<DbRow>(
        `SELECT * FROM buyer_confirmation_submissions WHERE request_hash = $1`,
        [bytea(requestHash)],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async getActiveConfirmationSubmission(
      paymentId: bigint,
    ): Promise<ConfirmationSubmissionRow | null> {
      const result = await pool.query<DbRow>(
        `SELECT *
           FROM buyer_confirmation_submissions
          WHERE payment_id = $1 AND status IN ('prepared', 'broadcast')
          LIMIT 1`,
        [paymentId.toString()],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async getActiveConfirmationSubmissionByNonce(
      attester: Hex,
      easAttesterNonce: bigint,
    ): Promise<ConfirmationSubmissionRow | null> {
      const result = await pool.query<DbRow>(
        `SELECT *
           FROM buyer_confirmation_submissions
          WHERE attester = $1
            AND eas_attester_nonce = $2
            AND status IN ('prepared', 'broadcast')
          LIMIT 1`,
        [bytea(attester), easAttesterNonce.toString()],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async listActiveConfirmationSubmissions(
      limit = 50,
    ): Promise<ConfirmationSubmissionRow[]> {
      const result = await pool.query<DbRow>(
        `SELECT *
           FROM buyer_confirmation_submissions
          WHERE status IN ('prepared', 'broadcast')
          ORDER BY updated_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(mapRow);
    },

    async countConfirmationSubmissions(paymentId: bigint): Promise<number> {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM buyer_confirmation_submissions
          WHERE payment_id = $1`,
        [paymentId.toString()],
      );
      return Number(result.rows[0]?.count ?? "0");
    },

    async reserveConfirmationSubmission(
      client: PoolClient,
      input: {
        id: string;
        paymentId: bigint;
        attester: Hex;
        easAttesterNonce: bigint;
        confirmation: ConfirmationSubmissionRow["confirmation"];
        refUid: Hex | null;
        requestHash: Hex;
        facilitatorTransactionId: string;
        paymentLimit: number;
        walletDailyLimit: number;
        globalDailyLimit: number;
      },
    ): Promise<ConfirmationSponsorshipLimit | null> {
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM buyer_confirmation_submissions
          WHERE payment_id = $1`,
        [input.paymentId.toString()],
      );
      if (Number(count.rows[0]?.count ?? "0") >= input.paymentLimit) {
        return "payment";
      }
      const walletKey = `wallet:${input.attester.toLowerCase()}`;
      if (
        !(await consumeBucket(client, walletKey, input.walletDailyLimit))
      ) {
        return "wallet";
      }
      if (!(await consumeBucket(client, "global", input.globalDailyLimit))) {
        return "global";
      }
      await client.query(
        `INSERT INTO buyer_confirmation_submissions
           (id, payment_id, attester, eas_attester_nonce, confirmation,
            ref_uid, request_hash, facilitator_transaction_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepared')`,
        [
          input.id,
          input.paymentId.toString(),
          bytea(input.attester),
          input.easAttesterNonce.toString(),
          input.confirmation,
          input.refUid ? bytea(input.refUid) : null,
          bytea(input.requestHash),
          input.facilitatorTransactionId,
        ],
      );
      return null;
    },

    async markConfirmationSubmissionBroadcast(
      client: PoolClient,
      requestHash: Hex,
      transactionId: string,
    ): Promise<void> {
      const result = await client.query(
        `UPDATE buyer_confirmation_submissions
            SET status = 'broadcast', updated_at = now()
          WHERE request_hash = $1
            AND facilitator_transaction_id = $2
            AND status IN ('prepared', 'broadcast')`,
        [bytea(requestHash), transactionId],
      );
      if (result.rowCount !== 1) {
        throw new Error("confirmation broadcast state conflict");
      }
    },

    async finishConfirmationSubmission(
      client: PoolClient,
      requestHash: Hex,
      transactionId: string,
      outcome:
        | { status: "confirmed"; attestationUid: Hex }
        | { status: "reverted" | "nonce_conflict" },
    ): Promise<void> {
      const result = await client.query(
        `UPDATE buyer_confirmation_submissions
            SET status = $3,
                attestation_uid = $4,
                updated_at = now()
          WHERE request_hash = $1
            AND facilitator_transaction_id = $2
            AND status IN ('prepared', 'broadcast')`,
        [
          bytea(requestHash),
          transactionId,
          outcome.status,
          outcome.status === "confirmed"
            ? bytea(outcome.attestationUid)
            : null,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("confirmation finalization state conflict");
      }
    },
  };
}

async function consumeBucket(
  client: PoolClient,
  key: string,
  limit: number,
): Promise<boolean> {
  const result = await client.query<{ sponsorship_count: number }>(
    `INSERT INTO confirmation_sponsorship_buckets
       (bucket_key, window_date, sponsorship_count)
     VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
     ON CONFLICT (bucket_key, window_date) DO UPDATE
       SET sponsorship_count =
             confirmation_sponsorship_buckets.sponsorship_count + 1,
           updated_at = now()
       WHERE confirmation_sponsorship_buckets.sponsorship_count < $2
     RETURNING sponsorship_count`,
    [key, limit],
  );
  return result.rowCount === 1;
}
