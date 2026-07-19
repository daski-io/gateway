import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  cardsOf,
  extractAgentCardUrl,
  parseAgentSkills,
} from "../discovery/format.js";
import { buildServiceLegal } from "../legal/purchase.js";

export function buildX402Catalog(
  config: Config,
  cache: DiscoveryCache,
): Array<Record<string, unknown>> {
  return cache.getAll().flatMap((provider) => {
    if (!provider.providerLegal) return [];
    const legal = buildServiceLegal(config, provider.providerLegal);
    return cardsOf(provider).flatMap((providerCard) => {
      const card = providerCard.agentCard as { name?: string };
      const skills = parseAgentSkills(providerCard.agentCard);
      const providerA2AUrl = extractAgentCardUrl(providerCard.agentCard);

      return skills.flatMap((skill) => {
        const metadata = skill.metadata;
        if (metadata.paymentRequired === false) return [];

        const pricing =
          metadata.pricing &&
          typeof metadata.pricing === "object" &&
          !Array.isArray(metadata.pricing)
            ? (metadata.pricing as Record<string, unknown>)
            : null;
        const amount =
          typeof metadata.baseAmount === "string"
            ? metadata.baseAmount
            : typeof pricing?.baseAmount === "string" &&
                pricing.baseAmount !== "0"
              ? pricing.baseAmount
              : null;
        if (!amount) return [];

        const resource = config.directAdapterAddress
          ? `${config.publicUrl}/x402/services/${provider.agentId.toString()}/${encodeURIComponent(providerCard.serviceSlug)}/${encodeURIComponent(skill.id)}`
          : `${config.publicUrl}/purchase/${provider.agentId.toString()}`;
        return [
          {
            resource,
            scheme: "exact",
            network: config.network,
            asset: config.usdcAddress,
            payTo: config.paymentRouterAddress,
            maxAmountRequired: amount,
            description: `${card.name ?? "provider"} — ${skill.id}`,
            providerTokenId: provider.agentId.toString(),
            serviceSlug: providerCard.serviceSlug,
            skillId: skill.id,
            providerA2AUrl,
            legal,
          },
        ];
      });
    });
  });
}
