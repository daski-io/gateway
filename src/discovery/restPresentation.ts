import { DASKI_A2A_EXTENSION_URI } from "../config.js";
import { buildServiceLegal } from "../legal/purchase.js";
import type { MarketplaceLegalUrls } from "../legal/types.js";
import type { CachedProvider } from "../types.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";
import { cardsOf } from "./agentCard.js";

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
    cards: cardsOf(provider).map((card) => ({
      endpoint: card.endpoint,
      serviceSlug: card.serviceSlug,
      agentCard: sanitizeForLlmReflection(withCanonicalLegal(card.agentCard, legal), {
        stringMax: 4_000,
        maxDepth: 12,
      }),
      legal,
    })),
    lastFetched: provider.lastFetched.toISOString(),
    fetchError: provider.fetchError,
  };
}

function withCanonicalLegal(
  agentCard: Record<string, unknown>,
  legal: ReturnType<typeof buildServiceLegal>,
): Record<string, unknown> {
  const extensions =
    agentCard.extensions && typeof agentCard.extensions === "object"
      ? (agentCard.extensions as Record<string, unknown>)
      : {};
  const current =
    extensions[DASKI_A2A_EXTENSION_URI] &&
    typeof extensions[DASKI_A2A_EXTENSION_URI] === "object"
      ? (extensions[DASKI_A2A_EXTENSION_URI] as Record<string, unknown>)
      : {};
  return {
    ...agentCard,
    extensions: {
      ...extensions,
      [DASKI_A2A_EXTENSION_URI]: { ...current, legal },
    },
  };
}
