import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import type { CachedProvider, DaskiMarketplaceExtension } from "../types.js";
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

export function extractAgentCardUrl(
  agentCard: Record<string, unknown>,
): string | null {
  const url = agentCard["url"];
  return typeof url === "string" ? url : null;
}

export interface DiscoverFilters {
  category?: string;
  maxPrice?: number; // Human-readable USDC (e.g. 100 for 100 USDC)
}

export function applyDiscoverFilters(
  providers: CachedProvider[],
  filters: DiscoverFilters,
): CachedProvider[] {
  if (!filters.category && filters.maxPrice === undefined) {
    return providers;
  }
  return providers.filter((p) => {
    const ext = extractMarketplaceExtension(p.agentCard);
    if (!ext) return false; // Providers without the extension are excluded from filtered queries
    if (filters.category && ext.category !== filters.category) return false;
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
  });
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
      priceList: formatPriceList(meta.priceList),
      baseAmount:
        meta.baseAmount !== undefined && meta.baseAmount !== null
          ? (Number(meta.baseAmount) / 1_000_000).toFixed(2)
          : undefined,
      requiredFields: meta.requiredFields,
      requiresAssetOwnership: meta.requiresAssetOwnership ?? false,
      requiresCapability: meta.requiresCapability ?? false,
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
    const ext = extractMarketplaceExtension(provider.agentCard);
    if (!ext) continue;
    const name = extractAgentCardName(provider.agentCard);
    const providerA2AUrl = extractAgentCardUrl(provider.agentCard);
    const skills = extractSkills(provider.agentCard);

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
      skills: sanitizeForLlmReflection(skills),
    };
    if (pricingModel) {
      entry.pricingModel = pricingModel;
    } else if (baseAmountRaw !== undefined && baseAmountRaw !== null) {
      entry.basePrice = (Number(baseAmountRaw) / 1_000_000).toFixed(2);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Serializes a cached provider for the REST /discover response. BigInts
 * become strings, dates become ISO, agent card is returned as-is.
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
    lastFetched: provider.lastFetched.toISOString(),
    fetchError: provider.fetchError,
  };
}
