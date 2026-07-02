import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type {
  CachedProvider,
  DaskiMarketplaceExtension,
  ProviderCard,
} from "../types.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";

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

// A2A v1.0 moved the primary endpoint into `supportedInterfaces[0].url`;
// v0.3 cards still carry it at the top level as `url`. Gateway sees both
// in the wild (one provider can update ahead of another), so we read the
// v1 location first and fall back to v0.3 — don't drop the legacy branch
// without auditing every provider that landed before the v1.0 cutover.
//
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
  const legacy = agentCard["url"];
  return typeof legacy === "string" ? legacy : null;
}

/**
 * The provider's cards, tolerating cache entries built before the
 * multi-card refactor (tests, or a deploy race): a provider without a
 * `cards` array is treated as a single-card provider wrapping its
 * legacy `agentCard`.
 */
export function cardsOf(provider: CachedProvider): ProviderCard[] {
  if (Array.isArray(provider.cards) && provider.cards.length > 0) {
    return provider.cards;
  }
  return [
    {
      endpoint: provider.agentURI,
      serviceSlug: extractCardServiceSlug(provider.agentCard),
      agentCard: provider.agentCard,
    },
  ];
}

/**
 * The on-chain service slug a card represents. Cards are per-service, so
 * every skill carries the same `serviceSlug` in its daski metadata — read
 * it off the first skill that declares one (either publishing shape).
 * Null for legacy cards with no declared slug.
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
  const skills = agentCard["skills"];
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const meta = (skill as Record<string, unknown>)["metadata"];
      if (!meta || typeof meta !== "object") continue;
      const daski = (meta as Record<string, unknown>)[DASKI_A2A_EXTENSION_URI];
      if (!daski || typeof daski !== "object") continue;
      const slug = (daski as Record<string, unknown>)["serviceSlug"];
      if (typeof slug === "string" && slug.length > 0) return slug;
    }
  }
  return null;
}

/**
 * The card that offers `skillId`, for skill-scoped flows (payment
 * requirements, buy). Skill ids are only unique WITHIN a service, so the
 * first card listing the skill wins — in practice cross-card collisions
 * are free utility skills (check-availability, get-pricing) that never
 * reach the paid path. Falls back to null when no card lists the skill.
 */
export function findCardForSkill(
  provider: CachedProvider,
  skillId: string | null | undefined,
): Record<string, unknown> | null {
  if (!skillId) return null;
  for (const card of cardsOf(provider)) {
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
  category?: string;
  maxPrice?: number; // Human-readable USDC (e.g. 100 for 100 USDC)
}

// §1.6 of daski-mcp-gateway-fix-brief.md — agents guess category strings
// from user intent ("domain-registration", "register a domain", …) but
// providers register under one of the canonical buckets. Map common
// alternates → canonical so the filter doesn't zero out results that
// the agent obviously meant to include. New aliases extend cheaply.
const CATEGORY_ALIASES: Record<string, string> = {
  "domain-registration": "infrastructure",
  domains: "infrastructure",
  dns: "infrastructure",
  hosting: "infrastructure",
  "llc-formation": "legal",
  "company-formation": "legal",
  llc: "legal",
  ein: "legal",
  email: "communications",
  sms: "communications",
  messaging: "communications",
  banking: "finance",
  cards: "finance",
  payments: "finance",
  filings: "compliance",
  tax: "compliance",
};

/** Map a buyer-supplied category string to its canonical bucket. The
 *  canonical bucket falls through unchanged. Comparison is case- and
 *  whitespace-insensitive. */
export function canonicalizeCategory(input: string): string {
  const norm = input.trim().toLowerCase();
  return CATEGORY_ALIASES[norm] ?? input;
}

export function applyDiscoverFilters(
  providers: CachedProvider[],
  filters: DiscoverFilters,
): CachedProvider[] {
  if (!filters.category && filters.maxPrice === undefined) {
    return providers;
  }
  // §1.6 — match accepts either the buyer-supplied label OR its
  // canonical bucket. Both sides of the alias work so we don't break
  // providers that still register under the colloquial name (e.g.
  // `domain-registration`) before adopting the canonical enum.
  const acceptedCategories = filters.category
    ? new Set([filters.category, canonicalizeCategory(filters.category)])
    : null;

  const cardMatches = (card: ProviderCard): boolean => {
    const ext = extractMarketplaceExtension(card.agentCard);
    if (!ext) return false; // Cards without the extension are excluded from filtered queries
    if (acceptedCategories) {
      const providerCategory =
        typeof ext.category === "string" ? ext.category : "";
      // Canonicalize BOTH sides: a provider registering under the
      // colloquial label ("email") must match a buyer filtering by the
      // canonical bucket ("communications") and vice versa.
      if (
        !acceptedCategories.has(providerCategory) &&
        !acceptedCategories.has(canonicalizeCategory(providerCategory))
      ) {
        return false;
      }
    }
    if (filters.maxPrice !== undefined) {
      // Live-priced services advertise no fixed baseAmount — exclude
      // them from a maxPrice filter rather than applying it (the answer
      // can only be "depends on what you buy", not a single number).
      // Callers that want to constrain by quote can call /quote per skill.
      const baseAmount = ext.pricing?.baseAmount;
      if (baseAmount === undefined || baseAmount === null) return false;
      const priceUsdc = Number(baseAmount) / 1_000_000;
      if (!Number.isFinite(priceUsdc) || priceUsdc > filters.maxPrice) return false;
    }
    return true;
  };

  // Filter per CARD: a multi-service provider survives with the subset
  // of its cards that match; drops out only when none do. The pruned
  // provider keeps `agentCard` pointed at its first surviving card so
  // legacy single-card readers stay coherent.
  const out: CachedProvider[] = [];
  for (const p of providers) {
    const surviving = cardsOf(p).filter(cardMatches);
    if (surviving.length === 0) continue;
    out.push({ ...p, agentCard: surviving[0]!.agentCard, cards: surviving });
  }
  return out;
}

/**
 * Extracts skill-level metadata from an Agent Card. Supports both
 * publishing shapes observed in the wild:
 *   A) `skills[i].metadata[DASKI_A2A_EXTENSION_URI]` — per-skill metadata.
 *   B) `extensions[DASKI_A2A_EXTENSION_URI].skills[skillId]` — map keyed
 *      by skillId inside the marketplace extension (what daski-provider
 *      actually serves today).
 * When a skill is listed in `skills[]` but only has metadata under shape B,
 * we still emit it in the result so callers see the skill. Skills with no
 * metadata at all are still emitted with metadata fields undefined so
 * agents can at least see their existence.
 */
function extractSkills(
  agentCard: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const skills = agentCard["skills"];
  if (!Array.isArray(skills)) return [];

  // Shape B lookup: single extension read, reused per skill below.
  const ext = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const shapeBMap =
    ext?.skills && typeof ext.skills === "object" && !Array.isArray(ext.skills)
      ? (ext.skills as Record<string, unknown>)
      : null;

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
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const s = skill as Record<string, unknown>;
    const id = s.id;
    if (typeof id !== "string") continue;

    // Prefer shape A if present (per-skill metadata is more authoritative);
    // fall back to shape B; if neither, still emit the skill with the basic
    // fields so it's at least discoverable.
    const shapeAMeta =
      s.metadata &&
      typeof s.metadata === "object" &&
      (s.metadata as Record<string, unknown>)[DASKI_A2A_EXTENSION_URI];
    const shapeBMeta = shapeBMap?.[id];
    const meta =
      (shapeAMeta && typeof shapeAMeta === "object"
        ? (shapeAMeta as Record<string, unknown>)
        : null) ??
      (shapeBMeta && typeof shapeBMeta === "object"
        ? (shapeBMeta as Record<string, unknown>)
        : null) ??
      {};

    // baseAmount/priceList live at the metadata top level in older cards,
    // but daski-provider nests them under meta.pricing (the translated
    // per-skill pricing block). A nested "0" is the live-priced floor,
    // not a price — treat it as absent.
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
    const baseAmount = meta.baseAmount ?? nestedBase;
    const priceList = meta.priceList ?? nestedPricing?.priceList;

    out.push({
      id,
      name: s.name,
      description: s.description,
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
      // §3.2 of daski-mcp-gateway-fix-brief.md — surface the manifest's
      // optionalFields and the two-call callPhases block so agents can
      // schema-validate before paying for a round-trip. The provider
      // already emits both under extensions[uri].skills[skillId].
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
 *
 * Note: the response key is `tokenId` (historical); the value is the
 * ERC-8004 agentId.
 */
export function formatForSkillDiscover(
  providers: CachedProvider[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const provider of providers) {
    for (const card of cardsOf(provider)) {
      const entry = formatCardForSkillDiscover(provider, card);
      if (entry) out.push(entry);
    }
  }
  return out;
}

/**
 * One search/catalog entry per (provider, card). A multi-service provider
 * therefore surfaces once per service — same `tokenId`, distinct `name`,
 * `serviceSlug`, `skills[]`, and `providerA2AUrl`. Returns null for cards
 * without the marketplace extension.
 */
export function formatCardForSkillDiscover(
  provider: CachedProvider,
  card: ProviderCard,
): Record<string, unknown> | null {
    const ext = extractMarketplaceExtension(card.agentCard);
    if (!ext) return null;
    const name = extractAgentCardName(card.agentCard);
    const providerA2AUrl = extractAgentCardUrl(card.agentCard);
    const skills = extractSkills(card.agentCard);

    // Service-level pricing has two shapes:
    //   - live: baseAmount absent + pricing.model present
    //     → emit pricingModel, omit basePrice
    //   - fixed: baseAmount present
    //     → emit basePrice as USDC string
    // Provider's generator ALSO emits both `variable` (canonical) and
    // `variablePricing` (back-compat) for the boolean flag. Read both.
    const pricing = (ext.pricing ?? {}) as Record<string, unknown>;
    const pricingModel = pricing.model;
    const baseAmountRaw = pricing.baseAmount;
    const variablePricing =
      (pricing.variable as boolean | undefined) ??
      (pricing.variablePricing as boolean | undefined) ??
      false;

    const entry: Record<string, unknown> = {
      tokenId: provider.agentId.toString(),
      agentId: provider.agentId.toString(),
      // Which of the provider's services this entry describes. Skill ids
      // are only unique within a service — pair skillId with this slug
      // when disambiguating across a multi-service provider. Null for
      // legacy cards that don't declare one.
      serviceSlug: card.serviceSlug,
      // Provider-supplied free-text fields are reflected to LLM clients
      // via search_services / Resource reads. Strip control chars + BIDI
      // overrides and length-cap to blunt prompt-injection attempts from
      // a whitelisted-but-malicious provider. Numeric / structural
      // fields below pass through unchanged.
      name: sanitizeForLlmReflection(name),
      serviceDescription: sanitizeForLlmReflection(ext.serviceDescription),
      category: sanitizeForLlmReflection(ext.category),
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
      // §1.7 of daski-mcp-gateway-fix-brief.md — skill descriptions
      // (now ~1.5–2.5KB each after the 6-element-template rewrite) were
      // getting clipped at the default 1KB sanitizer cap, hiding the
      // inputs / capability-flow / next-step blocks that exist for the
      // agent. Raise the per-string cap inside the skills array so the
      // operational detail makes it through. Top-level fields keep the
      // default cap.
      skills: sanitizeForLlmReflection(skills, { stringMax: 4000 }),
    };
    if (pricingModel) {
      entry.pricingModel = pricingModel;
    } else if (baseAmountRaw !== undefined && baseAmountRaw !== null) {
      entry.basePrice = (Number(baseAmountRaw) / 1_000_000).toFixed(2);
    }
    return entry;
}

/**
 * Serializes a cached provider for the REST /discover response. BigInts
 * become strings, dates become ISO, agent card is returned as-is.
 * `cards` is the multi-service surface (one entry per advertised
 * service); `agentCard` remains the first card for back-compat.
 */
export function formatForRestDiscover(
  provider: CachedProvider,
): Record<string, unknown> {
  return {
    tokenId: provider.agentId.toString(),
    agentId: provider.agentId.toString(),
    walletAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    agentCard: provider.agentCard,
    cards: cardsOf(provider).map((c) => ({
      endpoint: c.endpoint,
      serviceSlug: c.serviceSlug,
      agentCard: c.agentCard,
    })),
    lastFetched: provider.lastFetched.toISOString(),
    fetchError: provider.fetchError,
  };
}
