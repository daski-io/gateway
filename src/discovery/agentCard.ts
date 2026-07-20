import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type {
  CachedProvider,
  DaskiMarketplaceExtension,
  ProviderCard,
} from "../types.js";

export function extractMarketplaceExtension(
  agentCard: Record<string, unknown>,
): DaskiMarketplaceExtension | null {
  const extensions = agentCard.extensions;
  if (!extensions || typeof extensions !== "object") return null;
  const extension = (extensions as Record<string, unknown>)[
    DASKI_A2A_EXTENSION_URI
  ];
  return extension && typeof extension === "object"
    ? (extension as DaskiMarketplaceExtension)
    : null;
}

export function extractAgentCardName(
  agentCard: Record<string, unknown>,
): string {
  return typeof agentCard.name === "string" ? agentCard.name : "(unnamed)";
}

export function extractAgentCardUrl(
  agentCard: Record<string, unknown>,
): string | null {
  const interfaces = agentCard.supportedInterfaces;
  if (!Array.isArray(interfaces) || interfaces.length === 0) return null;
  const first = interfaces[0];
  if (!first || typeof first !== "object") return null;
  const url = (first as Record<string, unknown>).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

export function cardsOf(provider: CachedProvider): ProviderCard[] {
  return provider.cards;
}

export function hasMarketplaceService(provider: CachedProvider): boolean {
  return (
    provider.providerLegal !== null &&
    cardsOf(provider).some(
      (card) => extractMarketplaceExtension(card.agentCard) !== null,
    )
  );
}

export function extractCardServiceSlug(
  agentCard: Record<string, unknown>,
): string | null {
  const extension = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const skills = extension?.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return null;
  for (const metadata of Object.values(skills as Record<string, unknown>)) {
    if (!metadata || typeof metadata !== "object") continue;
    const slug = (metadata as Record<string, unknown>).serviceSlug;
    if (typeof slug === "string" && slug.length > 0) return slug;
  }
  return null;
}

export function findCardForSkill(
  provider: CachedProvider,
  skillId: string | null | undefined,
  serviceSlug: string,
): Record<string, unknown> | null {
  if (!skillId) return null;
  for (const card of cardsOf(provider)) {
    if (card.serviceSlug !== serviceSlug) continue;
    const listedSkills = card.agentCard.skills;
    if (
      Array.isArray(listedSkills) &&
      listedSkills.some(
        (skill) =>
          skill &&
          typeof skill === "object" &&
          (skill as Record<string, unknown>).id === skillId,
      )
    ) {
      return card.agentCard;
    }
    const extension = extractMarketplaceExtension(card.agentCard) as
      | (Record<string, unknown> & { skills?: unknown })
      | null;
    const skills = extension?.skills;
    if (
      skills &&
      typeof skills === "object" &&
      !Array.isArray(skills) &&
      (skills as Record<string, unknown>)[skillId]
    ) {
      return card.agentCard;
    }
  }
  return null;
}

export interface ParsedAgentSkill {
  id: string;
  name: unknown;
  description: unknown;
  metadata: Record<string, unknown>;
}

export function parseAgentSkills(
  agentCard: Record<string, unknown>,
): ParsedAgentSkill[] {
  const skills = agentCard.skills;
  if (!Array.isArray(skills)) return [];
  const extension = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const metadataBySkill =
    extension?.skills &&
    typeof extension.skills === "object" &&
    !Array.isArray(extension.skills)
      ? (extension.skills as Record<string, unknown>)
      : {};
  return skills.flatMap((skill) => {
    if (!skill || typeof skill !== "object") return [];
    const record = skill as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    const metadata = metadataBySkill[record.id];
    return [
      {
        id: record.id,
        name: record.name,
        description: record.description,
        metadata:
          metadata && typeof metadata === "object"
            ? (metadata as Record<string, unknown>)
            : {},
      },
    ];
  });
}
