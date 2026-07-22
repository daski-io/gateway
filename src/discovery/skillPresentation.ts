import { buildServiceLegal } from "../legal/purchase.js";
import type { MarketplaceLegalUrls } from "../legal/types.js";
import type { CachedProvider, ProviderCard } from "../types.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";
import {
  cardsOf,
  extractAgentCardName,
  extractAgentCardUrl,
  extractMarketplaceExtension,
  parseAgentSkills,
} from "./agentCard.js";

export function formatForSkillDiscover(
  providers: CachedProvider[],
  marketplace: MarketplaceLegalUrls,
): Array<Record<string, unknown>> {
  return providers.flatMap((provider) =>
    cardsOf(provider).flatMap((card) => {
      const entry = formatCardForSkillDiscover(provider, card, marketplace);
      return entry ? [entry] : [];
    }),
  );
}

function formatCardForSkillDiscover(
  provider: CachedProvider,
  card: ProviderCard,
  marketplace: MarketplaceLegalUrls,
): Record<string, unknown> | null {
  const extension = extractMarketplaceExtension(card.agentCard);
  if (!extension || !provider.providerLegal) return null;
  const pricing = extension.pricing as Record<string, unknown>;
  const pricingModel = pricing.model;
  const baseAmount = pricing.baseAmount;
  const variablePricing =
    (pricing.variable as boolean | undefined) ??
    (pricing.variablePricing as boolean | undefined) ??
    false;
  const entry: Record<string, unknown> = {
    agentId: provider.agentId.toString(),
    serviceSlug: card.serviceSlug,
    name: sanitizeForLlmReflection(extractAgentCardName(card.agentCard)),
    serviceDescription: sanitizeForLlmReflection(extension.serviceDescription),
    categoryFamily: extension.categoryFamily,
    serviceType: extension.serviceType,
    jurisdictions: extension.jurisdictions,
    currency: pricing.currency,
    variablePricing,
    billingModel: pricing.billingModel,
    turnaroundEstimate: sanitizeForLlmReflection(extension.turnaroundEstimate),
    serviceLifecycle: extension.serviceLifecycle,
    agentCardUrl: provider.agentURI,
    providerA2AUrl: extractAgentCardUrl(card.agentCard),
    legal: buildServiceLegal(marketplace, provider.providerLegal),
    skills: sanitizeForLlmReflection(extractSkills(card.agentCard), {
      stringMax: 4_000,
    }),
  };
  if (pricingModel) entry.pricingModel = pricingModel;
  else if (baseAmount !== undefined && baseAmount !== null) {
    entry.basePrice = (Number(baseAmount) / 1_000_000).toFixed(2);
  }
  return entry;
}

function extractSkills(
  agentCard: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const extension = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  return parseAgentSkills(agentCard).map((skill) => {
    const metadata = skill.metadata;
    const pricing =
      metadata.pricing && typeof metadata.pricing === "object"
        ? (metadata.pricing as Record<string, unknown>)
        : null;
    const baseAmount =
      pricing?.baseAmount !== undefined &&
      pricing.baseAmount !== null &&
      String(pricing.baseAmount) !== "0"
        ? pricing.baseAmount
        : undefined;
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      paymentRequired: metadata.paymentRequired ?? true,
      variablePricing: metadata.variablePricing ?? false,
      ...(metadata.pricingModel ? { pricingModel: metadata.pricingModel } : {}),
      priceList: formatPriceList(pricing?.priceList),
      baseAmount:
        baseAmount !== undefined
          ? (Number(baseAmount) / 1_000_000).toFixed(2)
          : undefined,
      requiredFields: metadata.requiredFields,
      fulfillmentMode: metadata.fulfillmentMode ?? extension?.fulfillmentMode,
      ...(metadata.optionalFields != null
        ? { optionalFields: metadata.optionalFields }
        : {}),
      ...(metadata.callPhases != null ? { callPhases: metadata.callPhases } : {}),
      requiresAssetOwnership: metadata.requiresAssetOwnership ?? false,
      requiresCapability: metadata.requiresCapability ?? false,
      ...(typeof metadata.capabilityType === "string"
        ? { capabilityType: metadata.capabilityType }
        : {}),
      assetType: metadata.assetType,
    };
  });
}

function formatPriceList(raw: unknown): unknown {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (price): price is { item: string; amount: string | number } =>
          Boolean(
            price &&
              typeof price === "object" &&
              typeof (price as Record<string, unknown>).item === "string",
          ),
      )
      .map((price) => ({
        item: price.item,
        amount: (Number(price.amount) / 1_000_000).toFixed(2),
      }));
  }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([item, amount]) => ({
      item,
      amount: (Number(amount) / 1_000_000).toFixed(2),
    }));
  }
  return undefined;
}
