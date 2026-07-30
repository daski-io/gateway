import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { hexToBytea } from "./paymentChallengeCodec.js";

export interface TaskMappingRow {
  contextId: string;
  messageId: string | null;
  taskId: string;
  serviceRef: Hex | null;
  providerA2AUrl: string;
  skillId: string;
  buyerTokenId: bigint;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawRow {
  id: string;
  context_id: string;
  message_id: string | null;
  task_id: string | null;
  service_ref: Buffer | null;
  provider_a2a_url: string;
  skill_id: string;
  buyer_token_id: string;
  status: string | null;
  created_at: Date;
  updated_at: Date;
}

export class TaskMappingIntegrityError extends Error {
  constructor() {
    super("provider task is already bound to a different gateway dispatch");
    this.name = "TaskMappingIntegrityError";
  }
}

function toCompletedRow(raw: RawRow): TaskMappingRow {
  if (raw.task_id === null) throw new TaskMappingIntegrityError();
  return {
    contextId: raw.context_id,
    messageId: raw.message_id,
    taskId: raw.task_id,
    serviceRef: raw.service_ref
      ? (`0x${raw.service_ref.toString("hex")}` as Hex)
      : null,
    providerA2AUrl: raw.provider_a2a_url,
    skillId: raw.skill_id,
    buyerTokenId: BigInt(raw.buyer_token_id),
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
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
  id, context_id, message_id, task_id, service_ref, provider_a2a_url,
  skill_id, buyer_token_id, status, created_at, updated_at
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
    }): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO task_mappings
           (context_id, message_id, service_ref, provider_a2a_url,
            skill_id, buyer_token_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          mapping.contextId,
          mapping.messageId,
          mapping.serviceRef ? hexToBytea(mapping.serviceRef) : null,
          mapping.providerA2AUrl,
          mapping.skillId,
          mapping.buyerTokenId,
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
        if (!pending || pending.task_id !== null) {
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
              AND task_id = $2
            FOR UPDATE`,
          [pending.provider_a2a_url, taskId],
        );
        const existing = existingResult.rows[0];
        if (existing) {
          if (!sameBinding(existing, pending)) {
            throw new TaskMappingIntegrityError();
          }
          await client.query("DELETE FROM task_mappings WHERE id = $1", [
            mappingId,
          ]);
        } else {
          await client.query(
            `UPDATE task_mappings
                SET task_id = $2, status = $3, updated_at = now()
              WHERE id = $1`,
            [mappingId, taskId, status],
          );
        }
        await client.query(
          `DELETE FROM task_mappings
            WHERE id <> $1
              AND task_id IS NULL
              AND provider_a2a_url = $2
              AND skill_id = $3
              AND buyer_token_id = $4
              AND message_id IS NOT DISTINCT FROM $5
              AND service_ref IS NOT DISTINCT FROM $6`,
          [
            existing?.id ?? mappingId,
            pending.provider_a2a_url,
            pending.skill_id,
            pending.buyer_token_id,
            pending.message_id,
            pending.service_ref,
          ],
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
          WHERE id = $1 AND task_id IS NULL`,
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
            WHERE task_id IS NULL
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

    async completedTaskMapping(
      providerA2AUrl: string,
      taskId: string,
    ): Promise<TaskMappingRow | null> {
      const result = await pool.query<RawRow>(
        `SELECT ${SELECT_COLUMNS}
           FROM task_mappings
          WHERE provider_a2a_url = $1
            AND task_id = $2`,
        [providerA2AUrl, taskId],
      );
      return result.rows[0] ? toCompletedRow(result.rows[0]) : null;
    },
  };
}
