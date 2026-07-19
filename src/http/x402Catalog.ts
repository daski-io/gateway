import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  cardsOf,
  extractAgentCardUrl,
  extractMarketplaceExtension,
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
      const card = providerCard.agentCard as {
        name?: string;
        skills?: Array<Record<string, unknown>>;
      };
      const skills = Array.isArray(card.skills) ? card.skills : [];
      const providerA2AUrl = extractAgentCardUrl(providerCard.agentCard);
      const extension = extractMarketplaceExtension(
        providerCard.agentCard,
      ) as (Record<string, unknown> & { skills?: unknown }) | null;
      const skillMap =
        extension?.skills &&
        typeof extension.skills === "object" &&
        !Array.isArray(extension.skills)
          ? (extension.skills as Record<string, unknown>)
          : null;

      return skills.flatMap((skill) => {
        const inline = (
          skill.metadata as Record<string, unknown> | undefined
        )?.["https://daski.xyz/a2a/v1"] as
          | Record<string, unknown>
          | undefined;
        const mapped =
          typeof skill.id === "string" ? skillMap?.[skill.id] : undefined;
        const metadata =
          inline ??
          (mapped && typeof mapped === "object"
            ? (mapped as Record<string, unknown>)
            : undefined);
        if (!metadata || metadata.paymentRequired === false) return [];

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
          ? `${config.publicUrl}/x402/services/${provider.agentId.toString()}/${String(skill.id)}`
          : `${config.publicUrl}/purchase/${provider.agentId.toString()}`;
        return [
          {
            resource,
            scheme: "exact",
            network: config.network,
            asset: config.usdcAddress,
            payTo: config.paymentRouterAddress,
            maxAmountRequired: amount,
            description: `${card.name ?? "provider"} — ${String(skill.id)}`,
            providerTokenId: provider.agentId.toString(),
            skillId: skill.id,
            providerA2AUrl,
            legal,
          },
        ];
      });
    });
  });
}
