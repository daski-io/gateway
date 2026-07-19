import type { DiscoveryCache } from "../discovery/cache.js";
import {
  cardsOf,
  extractAgentCardUrl,
  parseAgentSkills,
} from "../discovery/format.js";
import type { CachedProvider, ProviderCard } from "../types.js";

export interface ProviderMatch {
  agentId: bigint;
  skillMeta: Record<string, unknown>;
  agentCard: Record<string, unknown>;
}

export interface CatalogA2AEndpoint {
  provider: CachedProvider;
  card: ProviderCard;
  url: string;
}

export interface CatalogSkillEndpoint extends CatalogA2AEndpoint {
  skillMeta: Record<string, unknown>;
}

export function findProvidersOfferingSkill(
  cache: DiscoveryCache,
  skillId: string,
): ProviderMatch[] {
  const matches: ProviderMatch[] = [];
  for (const provider of cache.getAll()) {
    const found = findSkillMeta(provider, skillId);
    if (found === null) continue;
    matches.push({
      agentId: provider.agentId,
      skillMeta: found.skillMeta,
      agentCard: found.agentCard,
    });
  }
  return matches;
}

export function findSkillMeta(
  provider: CachedProvider,
  skillId: string,
): {
  skillMeta: Record<string, unknown>;
  agentCard: Record<string, unknown>;
} | null {
  for (const card of cardsOf(provider)) {
    const skillMeta = skillMetaFromCard(card.agentCard, skillId);
    if (skillMeta !== null) {
      return { skillMeta, agentCard: card.agentCard };
    }
  }
  return null;
}

export function skillMetaFromCard(
  agentCard: Record<string, unknown>,
  skillId: string,
): Record<string, unknown> | null {
  return (
    parseAgentSkills(agentCard).find((skill) => skill.id === skillId)
      ?.metadata ?? null
  );
}

export function findCatalogA2AEndpoint(
  cache: DiscoveryCache,
  providerA2AUrl: string,
): CatalogA2AEndpoint | null {
  const target = normalizeA2AUrl(providerA2AUrl);
  if (!target) return null;
  for (const provider of cache.getAll()) {
    for (const card of cardsOf(provider)) {
      const url = extractAgentCardUrl(card.agentCard);
      if (url && normalizeA2AUrl(url) === target) {
        return { provider, card, url };
      }
    }
  }
  return null;
}

export function findCatalogSkillAtA2AEndpoint(
  cache: DiscoveryCache,
  providerA2AUrl: string,
  skillId: string,
): CatalogSkillEndpoint | null {
  const target = normalizeA2AUrl(providerA2AUrl);
  if (!target) return null;
  for (const provider of cache.getAll()) {
    for (const card of cardsOf(provider)) {
      const url = extractAgentCardUrl(card.agentCard);
      if (!url || normalizeA2AUrl(url) !== target) continue;
      const skillMeta = skillMetaFromCard(card.agentCard, skillId);
      if (skillMeta !== null) {
        return { provider, card, url, skillMeta };
      }
    }
  }
  return null;
}

export function normalizeA2AUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return null;
  }
}
