import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { hexToBytea } from "./paymentChallengeCodec.js";

export interface TaskMappingRow {
  contextId: string;
  taskId: string | null;
  providerA2AUrl: string;
  skillId: string;
  status: string | null;
  createdAt: Date;
}

interface RawRow {
  context_id: string;
  task_id: string | null;
  provider_a2a_url: string;
  skill_id: string;
  status: string | null;
  created_at: Date;
}

function toRow(raw: RawRow): TaskMappingRow {
  return {
    contextId: raw.context_id,
    taskId: raw.task_id,
    providerA2AUrl: raw.provider_a2a_url,
    skillId: raw.skill_id,
    status: raw.status,
    createdAt: raw.created_at,
  };
}

// Operation <-> A2A task mapping (migration 017). The pending row is
// written BEFORE the provider dispatch so a response lost in transport
// (PROVIDER_TIMEOUT after the provider acted — observed 2026-07-24)
// leaves a durable trace; the row is completed with the taskId when the
// response arrives. All writes are best-effort: a mapping failure must
// never fail a dispatch.
export function createTaskMappingQueries(pool: Pool) {
  return {
    async insertTaskMapping(mapping: {
      contextId: string;
      messageId: string | null;
      serviceRef: Hex | null;
      providerA2AUrl: string;
      skillId: string;
      buyerTokenId: string | null;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO task_mappings
           (context_id, message_id, service_ref, provider_a2a_url,
            skill_id, buyer_token_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          mapping.contextId,
          mapping.messageId,
          mapping.serviceRef ? hexToBytea(mapping.serviceRef) : null,
          mapping.providerA2AUrl,
          mapping.skillId,
          mapping.buyerTokenId,
        ],
      );
    },

    async completeTaskMapping(
      contextId: string,
      taskId: string,
      status: string,
    ): Promise<void> {
      await pool.query(
        `UPDATE task_mappings
            SET task_id = $2, status = $3, updated_at = now()
          WHERE id = (
            SELECT id FROM task_mappings
             WHERE context_id = $1
             ORDER BY created_at DESC
             LIMIT 1
          )`,
        [contextId, taskId, status],
      );
    },

    async latestTaskMappingByContext(
      contextId: string,
    ): Promise<TaskMappingRow | null> {
      const res = await pool.query<RawRow>(
        `SELECT context_id, task_id, provider_a2a_url, skill_id, status,
                created_at
           FROM task_mappings
          WHERE context_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [contextId],
      );
      return res.rows[0] ? toRow(res.rows[0]) : null;
    },

    async latestTaskMappingByServiceRef(
      serviceRef: Hex,
    ): Promise<TaskMappingRow | null> {
      const res = await pool.query<RawRow>(
        `SELECT context_id, task_id, provider_a2a_url, skill_id, status,
                created_at
           FROM task_mappings
          WHERE service_ref = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [hexToBytea(serviceRef)],
      );
      return res.rows[0] ? toRow(res.rows[0]) : null;
    },
  };
}
