import type { Pool } from "../db/pool.js";
import type { CachedProvider } from "../types.js";
import { type Embedder, vectorLiteral } from "./embeddings.js";
import { cardsOf, extractMarketplaceExtension } from "./format.js";

/**
 * Build the canonical source text for a skill embedding. Stable order so a
 * provider's cosmetic Agent Card edits don't churn embeddings.
 *
 * The format intentionally includes the card's `name` and high-level
 * `serviceDescription` so that a query like "register a domain" matches
 * even when the skill's own description is generic ("Register Domain").
 */
function skillSourceText(args: {
  providerName: string;
  serviceDescription: string;
  categoryFamily: string;
  serviceType: string;
  skillId: string;
  skillName: string;
  skillDescription: string;
}): string {
  return [
    `provider: ${args.providerName}`,
    `category family: ${args.categoryFamily}`,
    `service type: ${args.serviceType}`,
    `service: ${args.serviceDescription}`,
    `skill: ${args.skillId} — ${args.skillName}`,
    args.skillDescription ? `description: ${args.skillDescription}` : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

interface SkillEmbeddingTarget {
  providerAgentId: bigint;
  /** '' for legacy cards without a declared slug — matches the DB default. */
  serviceSlug: string;
  skillId: string;
  sourceText: string;
}

function collectTargets(providers: CachedProvider[]): SkillEmbeddingTarget[] {
  const out: SkillEmbeddingTarget[] = [];
  for (const provider of providers) {
    // One pass per CARD: a multi-service provider embeds every service's
    // skills, namespaced by the card's serviceSlug (skill ids collide
    // across services — e.g. check-availability on both the domain and
    // mailbox cards).
    for (const providerCard of cardsOf(provider)) {
      const ext = extractMarketplaceExtension(providerCard.agentCard);
      if (!ext) continue;
      const card = providerCard.agentCard as {
        name?: string;
        skills?: Array<{ id?: unknown; name?: unknown; description?: unknown }>;
      };
      const providerName = typeof card.name === "string" ? card.name : "";
      const serviceDescription =
        typeof ext.serviceDescription === "string" ? ext.serviceDescription : "";
      const serviceSlug = providerCard.serviceSlug ?? "";

      for (const skill of card.skills ?? []) {
        const skillId = typeof skill.id === "string" ? skill.id : "";
        if (!skillId) continue;
        const skillName = typeof skill.name === "string" ? skill.name : skillId;
        const skillDescription =
          typeof skill.description === "string" ? skill.description : "";
        out.push({
          providerAgentId: provider.agentId,
          serviceSlug,
          skillId,
          sourceText: skillSourceText({
            providerName,
            serviceDescription,
            categoryFamily: ext.categoryFamily,
            serviceType: ext.serviceType,
            skillId,
            skillName,
            skillDescription,
          }),
        });
      }
    }
  }
  return out;
}

/**
 * Sync `skill_embeddings` with the current discovery cache. Re-embeds only
 * skills whose source text changed; deletes rows for providers/skills no
 * longer present. Rows are keyed (provider, serviceSlug, skillId).
 */
export async function syncSkillEmbeddings(
  pool: Pool,
  providers: CachedProvider[],
  embedder: Embedder,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  const targets = collectTargets(providers);

  const existing = await pool.query<{
    provider_agent_id: string;
    service_slug: string;
    skill_id: string;
    source_text: string;
  }>(
    `SELECT provider_agent_id, service_slug, skill_id, source_text FROM skill_embeddings`,
  );
  const existingByKey = new Map<string, string>();
  for (const row of existing.rows) {
    existingByKey.set(
      `${row.provider_agent_id}:${row.service_slug}:${row.skill_id}`,
      row.source_text,
    );
  }

  const targetKeys = new Set<string>();
  const toEmbed: SkillEmbeddingTarget[] = [];
  for (const t of targets) {
    const key = `${t.providerAgentId.toString()}:${t.serviceSlug}:${t.skillId}`;
    targetKeys.add(key);
    const prior = existingByKey.get(key);
    if (prior !== t.sourceText) toEmbed.push(t);
  }

  let inserted = 0;
  let updated = 0;
  if (toEmbed.length > 0) {
    const vectors = await embedder.embedMany(toEmbed.map((t) => t.sourceText));
    for (let i = 0; i < toEmbed.length; i++) {
      const t = toEmbed[i]!;
      const v = vectors[i]!;
      const key = `${t.providerAgentId.toString()}:${t.serviceSlug}:${t.skillId}`;
      const isNew = !existingByKey.has(key);
      await pool.query(
        `INSERT INTO skill_embeddings
           (provider_agent_id, service_slug, skill_id, source_text, embedding, updated_at)
         VALUES ($1, $2, $3, $4, $5::vector, now())
         ON CONFLICT (provider_agent_id, service_slug, skill_id) DO UPDATE SET
           source_text = EXCLUDED.source_text,
           embedding   = EXCLUDED.embedding,
           updated_at  = now()`,
        [
          t.providerAgentId.toString(),
          t.serviceSlug,
          t.skillId,
          t.sourceText,
          vectorLiteral(v),
        ],
      );
      if (isNew) inserted++;
      else updated++;
    }
  }

  // Drop rows for skills/providers no longer in the cache. Keys are
  // colon-joined triples — slugs and skill ids are kebab-case and can't
  // contain ':'.
  const stale = [...existingByKey.keys()].filter((k) => !targetKeys.has(k));
  let deleted = 0;
  for (const k of stale) {
    const [providerId, serviceSlug, skillId] = k.split(":");
    const res = await pool.query(
      `DELETE FROM skill_embeddings
        WHERE provider_agent_id = $1 AND service_slug = $2 AND skill_id = $3`,
      [providerId, serviceSlug, skillId],
    );
    deleted += res.rowCount ?? 0;
  }

  return { inserted, updated, deleted };
}
