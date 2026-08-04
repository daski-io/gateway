import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { hexToBytea } from "./paymentChallengeCodec.js";

export interface TaskMappingRow {
  contextId: string;
  messageId: string | null;
  providerTaskId: string;
  serviceRef: Hex | null;
  providerA2AUrl: string;
  skillId: string;
  buyerTokenId: bigint;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface RawRow {
  id: string;
  context_id: string;
  message_id: string | null;
  provider_task_id: string | null;
  public_id_hash: Buffer;
  service_ref: Buffer | null;
  provider_a2a_url: string;
  skill_id: string;
  buyer_token_id: string;
  status: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

export class TaskMappingIntegrityError extends Error {
  constructor() {
    super("provider task is already bound to a different gateway dispatch");
    this.name = "TaskMappingIntegrityError";
  }
}

function toCompletedRow(raw: RawRow): TaskMappingRow {
  if (raw.provider_task_id === null) throw new TaskMappingIntegrityError();
  return {
    contextId: raw.context_id,
    messageId: raw.message_id,
    providerTaskId: raw.provider_task_id,
    serviceRef: raw.service_ref
      ? (`0x${raw.service_ref.toString("hex")}` as Hex)
      : null,
    providerA2AUrl: raw.provider_a2a_url,
    skillId: raw.skill_id,
    buyerTokenId: BigInt(raw.buyer_token_id),
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    expiresAt: raw.expires_at,
  };
}

function sameBinding(left: RawRow, right: RawRow): boolean {
  return (
    left.provider_a2a_url === right.provider_a2a_url &&
    left.skill_id === right.skill_id &&
    BigInt(left.buyer_token_id) === BigInt(right.buyer_token_id) &&
    left.message_id === right.message_id &&
    buffersEqual(left.service_ref, right.service_ref)
  );
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

const SELECT_COLUMNS = `
  id, context_id, message_id, provider_task_id, public_id_hash,
  service_ref, provider_a2a_url, skill_id, buyer_token_id, status,
  created_at, updated_at, expires_at
`;

export function createTaskMappingQueries(pool: Pool) {
  return {
    async insertTaskMapping(mapping: {
      contextId: string;
      messageId: string | null;
      serviceRef: Hex | null;
      providerA2AUrl: string;
      skillId: string;
      buyerTokenId: string;
      publicIdHash: Buffer;
      expiresAt: Date;
    }): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO task_mappings
           (context_id, message_id, service_ref, provider_a2a_url,
            skill_id, buyer_token_id, public_id_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          mapping.contextId,
          mapping.messageId,
          mapping.serviceRef ? hexToBytea(mapping.serviceRef) : null,
          mapping.providerA2AUrl,
          mapping.skillId,
          mapping.buyerTokenId,
          mapping.publicIdHash,
          mapping.expiresAt,
        ],
      );
      return result.rows[0]!.id;
    },

    async completeTaskMapping(
      mappingId: string,
      taskId: string,
      status: string,
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const pendingResult = await client.query<RawRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM task_mappings
            WHERE id = $1
            FOR UPDATE`,
          [mappingId],
        );
        const pending = pendingResult.rows[0];
        if (!pending || pending.provider_task_id !== null) {
          throw new TaskMappingIntegrityError();
        }
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [JSON.stringify([pending.provider_a2a_url, taskId])],
        );
        const existingResult = await client.query<RawRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM task_mappings
            WHERE provider_a2a_url = $1
              AND provider_task_id = $2
            FOR UPDATE`,
          [pending.provider_a2a_url, taskId],
        );
        if (existingResult.rows.some((row) => !sameBinding(row, pending))) {
          throw new TaskMappingIntegrityError();
        }
        await client.query(
          `UPDATE task_mappings
              SET provider_task_id = $2, status = $3, updated_at = now()
            WHERE id = $1`,
          [mappingId, taskId, status],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async deletePendingTaskMapping(mappingId: string): Promise<boolean> {
      const result = await pool.query(
        `DELETE FROM task_mappings
          WHERE id = $1 AND provider_task_id IS NULL`,
        [mappingId],
      );
      return result.rowCount === 1;
    },

    async deleteExpiredPendingTaskMappings(
      retentionSeconds: number,
      batchSize = 500,
    ): Promise<number> {
      const result = await pool.query(
        `WITH candidates AS (
           SELECT id
             FROM task_mappings
            WHERE provider_task_id IS NULL
              AND created_at < now() - ($1 * interval '1 second')
            ORDER BY created_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM task_mappings AS mapping
          USING candidates
          WHERE mapping.id = candidates.id`,
        [retentionSeconds, batchSize],
      );
      return result.rowCount ?? 0;
    },

    async completedTaskMapping(publicIdHash: Buffer): Promise<TaskMappingRow | null> {
      const result = await pool.query<RawRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM task_mappings
          WHERE public_id_hash = $1
            AND provider_task_id IS NOT NULL
            AND expires_at > now()`,
        [publicIdHash],
      );
      return result.rows[0] ? toCompletedRow(result.rows[0]) : null;
    },

    async updateTaskMappingStatus(
      publicIdHash: Buffer,
      status: string,
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE task_mappings
            SET status = $2, updated_at = now()
          WHERE public_id_hash = $1
            AND provider_task_id IS NOT NULL
            AND expires_at > now()`,
        [publicIdHash, status],
      );
      return result.rowCount === 1;
    },

    async deleteExpiredTaskMappings(batchSize = 500): Promise<number> {
      const result = await pool.query(
        `WITH candidates AS (
           SELECT id
             FROM task_mappings
            WHERE expires_at <= now()
            ORDER BY expires_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM task_mappings AS mapping
          USING candidates
          WHERE mapping.id = candidates.id`,
        [batchSize],
      );
      return result.rowCount ?? 0;
    },
  };
}
