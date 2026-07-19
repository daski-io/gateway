import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type {
  CachedProvider,
  DaskiMarketplaceExtension,
  ProviderCard,
} from "../types.js";
import {
  jurisdictionsOverlap,
  type CategoryFamily,
  type FulfillmentMode,
  type ServiceType,
} from "../serviceTaxonomy.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";
import { buildServiceLegal } from "../legal/purchase.js";
import type { MarketplaceLegalUrls } from "../legal/types.js";

// Attempts to extract the daski marketplace extension from an Agent Card.
// Returns null if the extension is missing or malformed.
export function extractMarketplaceExtension(
  agentCard: Record<string, unknown>,
): DaskiMarketplaceExtension | null {
  const extensions = agentCard["extensions"];
  if (!extensions || typeof extensions !== "object") return null;
  const ext = (extensions as Record<string, unknown>)[DASKI_A2A_EXTENSION_URI];
  if (!ext || typeof ext !== "object") return null;
  return ext as DaskiMarketplaceExtension;
}

export function extractAgentCardName(
  agentCard: Record<string, unknown>,
): string {
  const name = agentCard["name"];
  return typeof name === "string" ? name : "(unnamed)";
}

// Provider-level identity (icon, website) deliberately is NOT read from
// the AgentCard. It lives on the ERC-8004 registration file (image /
// external_url) and is sourced via DiscoveryCache.resolveAgentCard so a
// multi-service provider doesn't have to keep N copies in sync.
export function extractAgentCardUrl(
  agentCard: Record<string, unknown>,
): string | null {
  const interfaces = agentCard["supportedInterfaces"];
  if (Array.isArray(interfaces) && interfaces.length > 0) {
    const first = interfaces[0];
    if (first && typeof first === "object") {
      const url = (first as Record<string, unknown>)["url"];
      if (typeof url === "string" && url.length > 0) return url;
    }
  }
  return null;
}

export function cardsOf(provider: CachedProvider): ProviderCard[] {
  return provider.cards;
}

export function hasMarketplaceService(provider: CachedProvider): boolean {
  if (!provider.providerLegal) return false;
  return cardsOf(provider).some(
    (card) => extractMarketplaceExtension(card.agentCard) !== null,
  );
}

/**
 * The on-chain service slug a card represents. Cards are per-service, so
 * every skill carries the same `serviceSlug` in its daski metadata — read
 * it off the first skill that declares one.
 * Null when card metadata is incomplete.
 */
export function extractCardServiceSlug(
  agentCard: Record<string, unknown>,
): string | null {
  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const shapeB = ext?.skills;
  if (shapeB && typeof shapeB === "object" && !Array.isArray(shapeB)) {
    for (const meta of Object.values(shapeB as Record<string, unknown>)) {
      if (!meta || typeof meta !== "object") continue;
      const slug = (meta as Record<string, unknown>)["serviceSlug"];
      if (typeof slug === "string" && slug.length > 0) return slug;
    }
  }
  return null;
}

/**
 * The card that offers `skillId` within one explicitly selected service.
 * Skill ids are only unique within a service, so payment flows must never
 * select a card by skill id alone.
 */
export function findCardForSkill(
  provider: CachedProvider,
  skillId: string | null | undefined,
  serviceSlug: string,
): Record<string, unknown> | null {
  if (!skillId) return null;
  for (const card of cardsOf(provider)) {
    if (card.serviceSlug !== serviceSlug) continue;
    const skills = card.agentCard["skills"];
    if (Array.isArray(skills)) {
      const listed = skills.some(
        (s) =>
          s &&
          typeof s === "object" &&
          (s as Record<string, unknown>)["id"] === skillId,
      );
      if (listed) return card.agentCard;
    }
    // Shape B only (skill listed solely in the extension map).
    const ext = extractMarketplaceExtension(card.agentCard) as
      | (Record<string, unknown> & { skills?: unknown })
      | null;
    const map = ext?.skills;
    if (
      map &&
      typeof map === "object" &&
      !Array.isArray(map) &&
      (map as Record<string, unknown>)[skillId]
    ) {
      return card.agentCard;
    }
  }
  return null;
}

export interface DiscoverFilters {
  categoryFamily?: CategoryFamily;
  serviceType?: ServiceType;
  jurisdiction?: string;
  fulfillmentMode?: FulfillmentMode;
  maxPrice?: number; // Human-readable USDC (e.g. 100 for 100 USDC)
}

export function applyDiscoverFilters(
  providers: CachedProvider[],
  filters: DiscoverFilters,
): CachedProvider[] {
  if (
    !filters.categoryFamily &&
    !filters.serviceType &&
    !filters.jurisdiction &&
    !filters.fulfillmentMode &&
    filters.maxPrice === undefined
  ) {
    return providers;
  }

  const cardMatches = (card: ProviderCard): boolean => {
    const ext = extractMarketplaceExtension(card.agentCard);
    if (!ext) return false; // Cards without the extension are excluded from filtered queries
    if (
      filters.categoryFamily &&
      ext.categoryFamily !== filters.categoryFamily
    ) {
      return false;
    }
    if (filters.serviceType && ext.serviceType !== filters.serviceType) {
      return false;
    }
    if (
      filters.jurisdiction &&
      !jurisdictionsOverlap(ext.jurisdictions, filters.jurisdiction)
    ) {
      return false;
    }
    if (
      filters.fulfillmentMode &&
      !extractSkills(card.agentCard).some(
        (skill) => skill.fulfillmentMode === filters.fulfillmentMode,
      )
    ) {
      return false;
    }
    if (filters.maxPrice !== undefined) {
      // Live-priced services advertise no fixed baseAmount — exclude
      // them from a maxPrice filter rather than applying it (the answer
      // can only be "depends on what you buy", not a single number).
      // Callers that want to constrain by quote can call /quote per skill.
      const baseAmount = ext.pricing?.baseAmount;
      if (baseAmount === undefined || baseAmount === null) return false;
      const priceUsdc = Number(baseAmount) / 1_000_000;
      if (!Number.isFinite(priceUsdc) || priceUsdc > filters.maxPrice) {
        return false;
      }
    }
    return true;
  };

  // Filter per card: a multi-service provider survives with the subset
  // of its cards that match and drops out only when none do.
  const out: CachedProvider[] = [];
  for (const p of providers) {
    const surviving = cardsOf(p).filter(cardMatches);
    if (surviving.length === 0) continue;
    out.push({ ...p, cards: surviving });
  }
  return out;
}

export interface ParsedAgentSkill {
  id: string;
  name: unknown;
  description: unknown;
  metadata: Record<string, unknown>;
}

/** Parse the current marketplace skill publishing shape. */
export function parseAgentSkills(
  agentCard: Record<string, unknown>,
): ParsedAgentSkill[] {
  const skills = agentCard["skills"];
  if (!Array.isArray(skills)) return [];
  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const metadataBySkill =
    ext?.skills && typeof ext.skills === "object" && !Array.isArray(ext.skills)
      ? (ext.skills as Record<string, unknown>)
      : {};
  const parsed: ParsedAgentSkill[] = [];
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const record = skill as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const metadata = metadataBySkill[record.id];
    parsed.push({
      id: record.id,
      name: record.name,
      description: record.description,
      metadata:
        metadata && typeof metadata === "object"
          ? (metadata as Record<string, unknown>)
          : {},
    });
  }
  return parsed;
}

/** Extract skill-level metadata for the discovery response. */
function extractSkills(
  agentCard: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;

  const formatPriceList = (raw: unknown): unknown => {
    if (!raw) return undefined;
    if (Array.isArray(raw)) {
      return raw
        .filter(
          (p): p is { item: string; amount: string | number } =>
            !!p &&
            typeof p === "object" &&
            typeof (p as Record<string, unknown>).item === "string",
        )
        .map((p) => ({
          item: p.item,
          amount: (Number(p.amount) / 1_000_000).toFixed(2),
        }));
    }
    if (typeof raw === "object") {
      return Object.entries(raw as Record<string, unknown>).map(([item, amount]) => ({
        item,
        amount: (Number(amount) / 1_000_000).toFixed(2),
      }));
    }
    return undefined;
  };

  const out: Array<Record<string, unknown>> = [];
  for (const skill of parseAgentSkills(agentCard)) {
    const { id, name, description, metadata: meta } = skill;

    const nestedPricing =
      meta.pricing && typeof meta.pricing === "object"
        ? (meta.pricing as Record<string, unknown>)
        : null;
    const nestedBase =
      nestedPricing?.baseAmount !== undefined &&
      nestedPricing?.baseAmount !== null &&
      String(nestedPricing.baseAmount) !== "0"
        ? nestedPricing.baseAmount
        : undefined;
    const baseAmount = nestedBase;
    const priceList = nestedPricing?.priceList;

    out.push({
      id,
      name,
      description,
      paymentRequired: meta.paymentRequired ?? true,
      variablePricing: meta.variablePricing ?? false,
      // Pass through the live-pricing marker when present; otherwise
      // surface the static numbers. Both shapes are mutually exclusive
      // on the provider side: live-priced skills have no baseAmount/
      // priceList, fixed-priced ones have no pricingModel.
      ...(meta.pricingModel ? { pricingModel: meta.pricingModel } : {}),
      priceList: formatPriceList(priceList),
      baseAmount:
        baseAmount !== undefined && baseAmount !== null
          ? (Number(baseAmount) / 1_000_000).toFixed(2)
          : undefined,
      requiredFields: meta.requiredFields,
      fulfillmentMode: meta.fulfillmentMode ?? ext?.fulfillmentMode,
      // Surface optional fields and two-call phase metadata so agents can
      // validate inputs before paying for a provider round trip.
      ...(meta.optionalFields !== undefined && meta.optionalFields !== null
        ? { optionalFields: meta.optionalFields }
        : {}),
      ...(meta.callPhases !== undefined && meta.callPhases !== null
        ? { callPhases: meta.callPhases }
        : {}),
      requiresAssetOwnership: meta.requiresAssetOwnership ?? false,
      requiresCapability: meta.requiresCapability ?? false,
      ...(typeof meta.capabilityType === "string"
        ? { capabilityType: meta.capabilityType }
        : {}),
      assetType: meta.assetType,
    });
  }
  return out;
}

/**
 * Flattens a cached provider + its Agent Card into the compact shape the
 * skill's search_services action returns. Drops providers without the
 * marketplace extension.
 */
export function formatForSkillDiscover(
  providers: CachedProvider[],
  marketplace: MarketplaceLegalUrls,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const provider of providers) {
    for (const card of cardsOf(provider)) {
      const entry = formatCardForSkillDiscover(provider, card, marketplace);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/**
 * One search/catalog entry per (provider, card). A multi-service provider
 * therefore surfaces once per service — same `agentId`, distinct `name`,
 * `serviceSlug`, `skills[]`, and `providerA2AUrl`. Returns null for cards
 * without the marketplace extension.
 */
export function formatCardForSkillDiscover(
  provider: CachedProvider,
  card: ProviderCard,
  marketplace: MarketplaceLegalUrls,
): Record<string, unknown> | null {
    const ext = extractMarketplaceExtension(card.agentCard);
    if (!ext || !provider.providerLegal) return null;
    const name = extractAgentCardName(card.agentCard);
    const providerA2AUrl = extractAgentCardUrl(card.agentCard);
    const skills = extractSkills(card.agentCard);

    // Service-level pricing has two shapes:
    //   - live: baseAmount absent + pricing.model present
    //     → emit pricingModel, omit basePrice
    //   - fixed: baseAmount present
    //     → emit basePrice as USDC string
    // Normalize the two service-level variability fields used by the
    // marketplace extension and public pricing schema.
    const pricing = (ext.pricing ?? {}) as Record<string, unknown>;
    const pricingModel = pricing.model;
    const baseAmountRaw = pricing.baseAmount;
    const variablePricing =
      (pricing.variable as boolean | undefined) ??
      (pricing.variablePricing as boolean | undefined) ??
      false;

    const entry: Record<string, unknown> = {
      agentId: provider.agentId.toString(),
      // Which of the provider's services this entry describes. Skill ids
      // are only unique within a service — pair skillId with this slug
      // when disambiguating across a multi-service provider.
      serviceSlug: card.serviceSlug,
      // Provider-supplied free-text fields are reflected to LLM clients
      // via search_services / Resource reads. Strip control chars + BIDI
      // overrides and length-cap to blunt prompt-injection attempts from
      // a whitelisted-but-malicious provider. Numeric / structural
      // fields below pass through unchanged.
      name: sanitizeForLlmReflection(name),
      serviceDescription: sanitizeForLlmReflection(ext.serviceDescription),
      categoryFamily: ext.categoryFamily,
      serviceType: ext.serviceType,
      jurisdictions: ext.jurisdictions,
      currency: pricing.currency,
      variablePricing,
      billingModel: pricing.billingModel,
      turnaroundEstimate: sanitizeForLlmReflection(ext.turnaroundEstimate),
      serviceLifecycle: ext.serviceLifecycle,
      // §5 — agentCardUrl is the well-known JSON URL the provider
      // publishes (provider.agentURI), per A2A spec. Surfaced here so
      // AgentKit-class agents can talk to the provider's A2A endpoint
      // directly without a follow-up fetch.
      agentCardUrl: provider.agentURI,
      providerA2AUrl,
      legal: buildServiceLegal(marketplace, provider.providerLegal),
      // Skill descriptions carry operational input and capability-flow
      // detail, so they use a larger bounded reflection limit.
      skills: sanitizeForLlmReflection(skills, { stringMax: 4000 }),
    };
    if (pricingModel) {
      entry.pricingModel = pricingModel;
    } else if (baseAmountRaw !== undefined && baseAmountRaw !== null) {
      entry.basePrice = (Number(baseAmountRaw) / 1_000_000).toFixed(2);
    }
    return entry;
}

function withCanonicalLegal(
  agentCard: Record<string, unknown>,
  legal: ReturnType<typeof buildServiceLegal>,
): Record<string, unknown> {
  const extensions =
    agentCard.extensions && typeof agentCard.extensions === "object"
      ? (agentCard.extensions as Record<string, unknown>)
      : {};
  const daskiExtension =
    extensions[DASKI_A2A_EXTENSION_URI] &&
    typeof extensions[DASKI_A2A_EXTENSION_URI] === "object"
      ? (extensions[DASKI_A2A_EXTENSION_URI] as Record<string, unknown>)
      : {};
  return {
    ...agentCard,
    extensions: {
      ...extensions,
      [DASKI_A2A_EXTENSION_URI]: {
        ...daskiExtension,
        legal,
      },
    },
  };
}

/**
 * Serializes a cached provider for the REST /discover response. BigInts
 * become strings, dates become ISO, agent card is returned as-is.
 * `cards` is the multi-service surface (one entry per advertised
 * service).
 */
export function formatForRestDiscover(
  provider: CachedProvider,
  marketplace: MarketplaceLegalUrls,
): Record<string, unknown> {
  if (!provider.providerLegal) {
    throw new Error("provider legal metadata is required for discovery");
  }
  const legal = buildServiceLegal(marketplace, provider.providerLegal);
  return {
    agentId: provider.agentId.toString(),
    walletAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    legal,
    cards: cardsOf(provider).map((c) => ({
      endpoint: c.endpoint,
      serviceSlug: c.serviceSlug,
      agentCard: withCanonicalLegal(c.agentCard, legal),
      legal,
    })),
    lastFetched: provider.lastFetched.toISOString(),
    fetchError: provider.fetchError,
  };
}
