import type { DiscoveryCache } from "../discovery/cache.js";
import {
  extractAgentCardUrl,
  extractMarketplaceExtension,
  findCardForSkill,
  parseAgentSkills,
} from "../discovery/agentCard.js";
import {
  computeServiceId,
  resolveServiceSlug,
  resolveServiceVersion,
} from "../discovery/serviceIdentity.js";
import type {
  CachedProvider,
  DaskiMarketplaceExtension,
  Hex,
} from "../types.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";

export interface SkillOffer {
  providerTokenId: bigint;
  skillId: string;
  serviceSlug: string;
  serviceVersion: string;
  serviceId: Hex;
  providerA2AUrl: string;
  /** Human description for payment discovery, limited for facilitators. */
  description: string;
}

export type SkillOfferResult =
  | { ok: true; offer: SkillOffer }
  | { ok: false; code: string; message: string; status: number };

/** Return current marketplace metadata for a listed skill. */
export function findSkillMetaForPricing(
  agentCard: Record<string, unknown>,
  skillId: string,
): Record<string, unknown> | null {
  return (
    parseAgentSkills(agentCard).find((skill) => skill.id === skillId)
      ?.metadata ?? null
  );
}

export function providerLegalAdmissionFailure(provider: CachedProvider): {
  ok: false;
  code: string;
  message: string;
  status: number;
} {
  const explicitlyInvalidLegalMetadata =
    provider.fetchError === null ||
    provider.fetchError.startsWith("invalid provider legal metadata:");
  return explicitlyInvalidLegalMetadata
    ? {
        ok: false,
        code: "provider_legal_metadata_invalid",
        message: "provider legal metadata is missing or invalid",
        status: 422,
      }
    : {
        ok: false,
        code: "provider_not_found",
        message: "provider is not currently admitted",
        status: 404,
      };
}

export function purchaseDescription(
  providerTokenId: bigint,
  agentCard: Record<string, unknown>,
  ext: DaskiMarketplaceExtension,
  skillId: string,
): string {
  const cardName =
    typeof agentCard.name === "string"
      ? agentCard.name
      : `provider ${providerTokenId}`;
  const serviceDescription =
    typeof ext.serviceDescription === "string" &&
    ext.serviceDescription.trim().length > 0
      ? ext.serviceDescription
      : typeof agentCard.description === "string" &&
          agentCard.description.trim().length > 0
        ? agentCard.description
        : "Service details are available from the Provider.";
  let skillDescription = skillId;
  const skills = agentCard.skills;
  if (Array.isArray(skills)) {
    const selected = skills.find(
      (skill) =>
        skill !== null &&
        typeof skill === "object" &&
        (skill as Record<string, unknown>).id === skillId,
    ) as Record<string, unknown> | undefined;
    if (
      typeof selected?.description === "string" &&
      selected.description.trim().length > 0
    ) {
      skillDescription = selected.description;
    }
  }
  return sanitizeForLlmReflection(
    `${cardName} — ${serviceDescription} Selected skill (${skillId}): ${skillDescription}`,
    { stringMax: 500 },
  );
}

/**
 * Resolves catalog identity for a provider skill. Pricing always comes from
 * a signed provider quote, never from the cached Agent Card.
 */
export function resolveSkillOffer(
  providerTokenId: bigint,
  skillId: string,
  cache: DiscoveryCache,
  opts: { serviceSlug: string },
): SkillOfferResult {
  const provider = cache.get(providerTokenId);
  if (!provider) {
    return {
      ok: false,
      code: "provider_not_found",
      message: "provider is not currently admitted",
      status: 404,
    };
  }
  if (!provider.providerLegal) {
    return providerLegalAdmissionFailure(provider);
  }
  if (skillId.length === 0 || skillId.length > 64) {
    return {
      ok: false,
      code: "skill_not_found",
      message: "skillId must be 1–64 bytes",
      status: 404,
    };
  }

  const agentCard = findCardForSkill(provider, skillId, opts.serviceSlug);
  if (!agentCard) {
    return {
      ok: false,
      code: "skill_not_found",
      message: `provider ${providerTokenId} does not list skill '${skillId}'`,
      status: 404,
    };
  }

  const ext = extractMarketplaceExtension(agentCard);
  const providerA2AUrl = extractAgentCardUrl(agentCard);
  if (!ext?.pricing || !providerA2AUrl) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card has no pricing extension or url",
      status: 422,
    };
  }

  const skillMeta = findSkillMetaForPricing(agentCard, skillId);
  if (skillMeta && skillMeta["paymentRequired"] === false) {
    return {
      ok: false,
      code: "skill_is_free",
      message: `skill '${skillId}' is free (ownership-gated); nothing to purchase`,
      status: 404,
    };
  }

  const serviceSlug = resolveServiceSlug(agentCard, skillId);
  if (!serviceSlug) {
    return {
      ok: false,
      code: "bad_service_slug",
      message: "skill metadata must declare a 1–64 byte serviceSlug",
      status: 422,
    };
  }
  if (serviceSlug !== opts.serviceSlug) {
    return {
      ok: false,
      code: "service_not_found",
      message:
        `provider ${providerTokenId} does not list skill '${skillId}' ` +
        `under service '${opts.serviceSlug}'`,
      status: 404,
    };
  }
  const serviceVersion = resolveServiceVersion(agentCard, skillId);
  const serviceId = computeServiceId(providerTokenId, serviceSlug, serviceVersion);

  return {
    ok: true,
    offer: {
      providerTokenId,
      skillId,
      serviceSlug,
      serviceVersion,
      serviceId,
      providerA2AUrl,
      description: purchaseDescription(
        providerTokenId,
        agentCard,
        ext,
        skillId,
      ),
    },
  };
}
