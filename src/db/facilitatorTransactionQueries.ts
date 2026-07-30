import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import type {
  FacilitatorOperationKind,
  FacilitatorOperationOwner,
  FacilitatorTransactionRow,
} from "./facilitatorTransactionTypes.js";

interface DbRow {
  id: string;
  operation_kind: FacilitatorTransactionRow["operationKind"];
  operation_key: string;
  attempt_number: number;
  intent_hash: Buffer;
  status: FacilitatorTransactionRow["status"];
  prepared_transaction: Buffer | null;
  transaction_hash: Buffer;
  transaction_nonce: string;
  operation_data: Record<string, unknown>;
  prepared_at: Date;
  broadcast_at: Date | null;
  resolved_at: Date | null;
  submission_attempts: number;
  receipt_checks: number;
  next_attempt_at: Date;
  failure_code: string | null;
}

const bytea = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

function mapRow(row: DbRow): FacilitatorTransactionRow {
  return {
    id: row.id,
    operationKind: row.operation_kind,
    operationKey: row.operation_key,
    attemptNumber: row.attempt_number,
    intentHash: hex(row.intent_hash),
    status: row.status,
    preparedTransaction: row.prepared_transaction
      ? hex(row.prepared_transaction)
      : null,
    transactionHash: hex(row.transaction_hash),
    transactionNonce: BigInt(row.transaction_nonce),
    operationData: row.operation_data,
    preparedAt: row.prepared_at,
    broadcastAt: row.broadcast_at,
    resolvedAt: row.resolved_at,
    submissionAttempts: row.submission_attempts,
    receiptChecks: row.receipt_checks,
    nextAttemptAt: row.next_attempt_at,
    failureCode: row.failure_code,
  };
}

export function createFacilitatorTransactionQueries(pool: Pool) {
  return {
    async getFacilitatorTransaction(
      owner: FacilitatorOperationOwner,
    ): Promise<FacilitatorTransactionRow | null> {
      const result = await pool.query<DbRow>(
        `SELECT *
           FROM facilitator_transactions
          WHERE operation_kind = $1 AND operation_key = $2
          ORDER BY attempt_number DESC
          LIMIT 1`,
        [owner.kind, owner.key],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async getFacilitatorTransactionById(
      id: string,
    ): Promise<FacilitatorTransactionRow | null> {
      const result = await pool.query<DbRow>(
        "SELECT * FROM facilitator_transactions WHERE id = $1",
        [id],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async highestUnresolvedFacilitatorNonce(
      client: PoolClient,
    ): Promise<bigint | null> {
      const result = await client.query<{ nonce: string | null }>(
        `SELECT max(transaction_nonce)::text AS nonce
           FROM facilitator_transactions
          WHERE status IN ('prepared', 'broadcast')`,
      );
      return result.rows[0]?.nonce == null
        ? null
        : BigInt(result.rows[0].nonce);
    },

    async insertFacilitatorTransaction(
      client: PoolClient,
      input: {
        id: string;
        owner: FacilitatorOperationOwner;
        intentHash: Hex;
        preparedTransaction: Hex;
        transactionHash: Hex;
        transactionNonce: bigint;
        operationData: Record<string, unknown>;
      },
    ): Promise<FacilitatorTransactionRow> {
      const result = await client.query<DbRow>(
        `INSERT INTO facilitator_transactions
           (id, operation_kind, operation_key, attempt_number, intent_hash,
            status, prepared_transaction, transaction_hash, transaction_nonce,
            operation_data, prepared_at)
         VALUES (
           $1, $2, $3,
           COALESCE((
             SELECT max(attempt_number) + 1
               FROM facilitator_transactions
              WHERE operation_kind = $2 AND operation_key = $3
           ), 1),
           $4, 'prepared', $5, $6, $7, $8, now()
         )
         RETURNING *`,
        [
          input.id,
          input.owner.kind,
          input.owner.key,
          bytea(input.intentHash),
          bytea(input.preparedTransaction),
          bytea(input.transactionHash),
          input.transactionNonce.toString(),
          JSON.stringify(input.operationData),
        ],
      );
      return mapRow(result.rows[0]!);
    },

    async markFacilitatorTransactionBroadcast(
      id: string,
      transactionHash: Hex,
      client?: PoolClient,
    ): Promise<boolean> {
      const result = await (client ?? pool).query(
        `UPDATE facilitator_transactions
            SET status = 'broadcast',
                broadcast_at = COALESCE(broadcast_at, now()),
                next_attempt_at = now() + interval '5 seconds',
                updated_at = now()
          WHERE id = $1
            AND status IN ('prepared', 'broadcast')
            AND transaction_hash = $2`,
        [id, bytea(transactionHash)],
      );
      return result.rowCount === 1;
    },

    async recordFacilitatorSubmissionAttempt(
      id: string,
      client?: PoolClient,
    ): Promise<boolean> {
      const result = await (client ?? pool).query(
        `UPDATE facilitator_transactions
            SET submission_attempts = submission_attempts + 1,
                next_attempt_at = now() + interval '5 seconds',
                failure_code = CASE
                  WHEN submission_attempts + 1 >= 8
                    THEN 'automatic_recovery_exhausted'
                  ELSE failure_code
                END,
                updated_at = now()
          WHERE id = $1
            AND status = 'prepared'
            AND submission_attempts < 8`,
        [id],
      );
      return result.rowCount === 1;
    },

    async finishFacilitatorTransaction(
      client: PoolClient,
      id: string,
      status: "succeeded" | "reverted" | "nonce_conflict",
      failureCode: string | null = null,
    ): Promise<boolean> {
      const result = await client.query(
        `UPDATE facilitator_transactions
            SET status = $2,
                prepared_transaction = NULL,
                broadcast_at = COALESCE(broadcast_at, now()),
                resolved_at = now(),
                failure_code = $3,
                updated_at = now()
          WHERE id = $1 AND status IN ('prepared', 'broadcast')`,
        [id, status, failureCode?.slice(0, 128) ?? null],
      );
      return result.rowCount === 1;
    },

    async listDueFacilitatorTransactions(
      operationKind: FacilitatorOperationKind,
      limit = 50,
    ): Promise<FacilitatorTransactionRow[]> {
      const result = await pool.query<DbRow>(
        `UPDATE facilitator_transactions
            SET receipt_checks = receipt_checks +
                  CASE WHEN status = 'broadcast' THEN 1 ELSE 0 END,
                next_attempt_at = now() + interval '10 seconds',
                updated_at = now()
          WHERE id IN (
            SELECT id
             FROM facilitator_transactions
             WHERE status IN ('prepared', 'broadcast')
               AND operation_kind = $1
               AND submission_attempts < 8
               AND failure_code IS NULL
               AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
         RETURNING *`,
        [operationKind, limit],
      );
      return result.rows.map(mapRow);
    },
  };
}
