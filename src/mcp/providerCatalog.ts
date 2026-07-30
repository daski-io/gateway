import type { DiscoveryCache } from "../discovery/cache.js";
import {
  cardsOf,
  extractAgentCardUrl,
  extractMarketplaceExtension,
  parseAgentSkills,
} from "../discovery/agentCard.js";
import type { CachedProvider, ProviderCard } from "../types.js";

export interface ProviderMatch {
  agentId: bigint;
  serviceSlug: string;
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
  serviceSlug: string,
): ProviderMatch[] {
  const matches: ProviderMatch[] = [];
  for (const provider of cache.getAll()) {
    const found = findSkillMeta(provider, skillId, serviceSlug);
    if (found === null) continue;
    matches.push({
      agentId: provider.agentId,
      serviceSlug,
      skillMeta: found.skillMeta,
      agentCard: found.agentCard,
    });
  }
  return matches;
}

function findSkillMeta(
  provider: CachedProvider,
  skillId: string,
  serviceSlug?: string,
): {
  skillMeta: Record<string, unknown>;
  agentCard: Record<string, unknown>;
} | null {
  for (const card of cardsOf(provider)) {
    if (serviceSlug !== undefined && card.serviceSlug !== serviceSlug) continue;
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

export function isCatalogArtifactUrl(
  cache: DiscoveryCache,
  providerA2AUrl: string,
  artifactUrl: string,
): boolean {
  return findCatalogArtifactEndpoint(cache, providerA2AUrl, artifactUrl) !== null;
}

export function findCatalogArtifactEndpoint(
  cache: DiscoveryCache,
  providerA2AUrl: string,
  artifactUrl: string,
): CatalogA2AEndpoint | null {
  const match = findCatalogA2AEndpoint(cache, providerA2AUrl);
  if (!match) return null;
  try {
    const providerEndpoint = new URL(match.url);
    const target = new URL(artifactUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username ||
      target.password
    ) {
      return null;
    }
    const allowedOrigins = new Set([providerEndpoint.origin]);
    const advertised = extractMarketplaceExtension(match.card.agentCard)
      ?.artifactOrigins;
    for (const origin of advertised ?? []) {
      allowedOrigins.add(new URL(origin).origin);
    }
    return allowedOrigins.has(target.origin) ? match : null;
  } catch {
    return null;
  }
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
