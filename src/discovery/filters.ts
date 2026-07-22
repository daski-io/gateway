import {
  jurisdictionsOverlap,
  type CategoryFamily,
  type FulfillmentMode,
  type ServiceType,
} from "../serviceTaxonomy.js";
import type { CachedProvider, ProviderCard } from "../types.js";
import {
  cardsOf,
  extractMarketplaceExtension,
  parseAgentSkills,
} from "./agentCard.js";

export interface DiscoverFilters {
  categoryFamily?: CategoryFamily;
  serviceType?: ServiceType;
  jurisdiction?: string;
  fulfillmentMode?: FulfillmentMode;
  maxPrice?: number;
}

export function applyDiscoverFilters(
  providers: CachedProvider[],
  filters: DiscoverFilters,
): CachedProvider[] {
  if (Object.values(filters).every((value) => value === undefined)) {
    return providers;
  }
  const matches = (card: ProviderCard): boolean => cardMatches(card, filters);
  return providers.flatMap((provider) => {
    const cards = cardsOf(provider).filter(matches);
    return cards.length > 0 ? [{ ...provider, cards }] : [];
  });
}

function cardMatches(card: ProviderCard, filters: DiscoverFilters): boolean {
  const extension = extractMarketplaceExtension(card.agentCard);
  if (!extension) return false;
  if (filters.categoryFamily && extension.categoryFamily !== filters.categoryFamily) {
    return false;
  }
  if (filters.serviceType && extension.serviceType !== filters.serviceType) return false;
  if (
    filters.jurisdiction &&
    !jurisdictionsOverlap(extension.jurisdictions, filters.jurisdiction)
  ) {
    return false;
  }
  if (
    filters.fulfillmentMode &&
    !parseAgentSkills(card.agentCard).some(
      (skill) =>
        (skill.metadata.fulfillmentMode ?? extension.fulfillmentMode) ===
        filters.fulfillmentMode,
    )
  ) {
    return false;
  }
  if (filters.maxPrice !== undefined) {
    const baseAmount = extension.pricing?.baseAmount;
    if (baseAmount === undefined || baseAmount === null) return false;
    const priceUsdc = Number(baseAmount) / 1_000_000;
    if (!Number.isFinite(priceUsdc) || priceUsdc > filters.maxPrice) return false;
  }
  return true;
}
