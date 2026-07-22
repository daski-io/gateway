import { vectorLiteral } from "../discovery/embeddings.js";
import type { Pool } from "./pool.js";

export interface SkillSearchHit {
  providerAgentId: bigint;
  serviceSlug: string;
  skillId: string;
  distance: number;
}

export function createSkillQueries(pool: Pool) {
  return {
    async searchSkillsByEmbedding(
      queryEmbedding: Float32Array | number[],
      limit: number,
    ): Promise<SkillSearchHit[]> {
      const result = await pool.query<{
        provider_agent_id: string;
        service_slug: string;
        skill_id: string;
        distance: number;
      }>(
        `SELECT provider_agent_id,
                service_slug,
                skill_id,
                (embedding <=> $1::vector)::float8 AS distance
           FROM skill_embeddings
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [vectorLiteral(queryEmbedding), limit],
      );
      return result.rows.map((row) => ({
        providerAgentId: BigInt(row.provider_agent_id),
        serviceSlug: row.service_slug ?? "",
        skillId: row.skill_id,
        distance: Number(row.distance),
      }));
    },
  };
}
