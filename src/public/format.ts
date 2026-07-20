import type {
  BuyerConfirmationLabel,
  TransactionOutcome,
} from "../chain/reader.js";
import {
  cardsOf,
  extractAgentCardName,
  extractAgentCardUrl,
  extractMarketplaceExtension,
  parseAgentSkills,
} from "../discovery/agentCard.js";
import { derivePrimaryServiceId } from "../discovery/serviceIdentity.js";
import { buildServiceLegal } from "../legal/purchase.js";
import type { MarketplaceLegalUrls } from "../legal/types.js";
import type { FulfillmentMode } from "../serviceTaxonomy.js";
import type { CachedProvider, ProviderCard } from "../types.js";
import type { PublicActivityRow } from "./reputation.js";
import type {
  PublicService,
  PublicServicePricing,
  PublicSkill,
  PublicSkillPricingModel,
} from "./serviceTypes.js";

export * from "./reputation.js";
export * from "./serviceTypes.js";

function atomicToUsdc(atomic: string | number | bigint): string {
  return (Number(atomic) / 1_000_000).toFixed(2);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function flattenSkills(agentCard: Record<string, unknown>): PublicSkill[] {
  const extension = extractMarketplaceExtension(agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const servicePricing =
    extension?.pricing && typeof extension.pricing === "object"
      ? (extension.pricing as Record<string, unknown>)
      : null;
  const skills: PublicSkill[] = [];
  for (const raw of parseAgentSkills(agentCard)) {
    const { id, metadata } = raw;
    const paymentRequired = metadata.paymentRequired !== false;
    const pricing =
      metadata.pricing && typeof metadata.pricing === "object"
        ? (metadata.pricing as Record<string, unknown>)
        : null;
    const effectiveBaseAmount =
      pricing?.baseAmount ?? (paymentRequired ? servicePricing?.baseAmount : null);
    const rawBasePrice =
      effectiveBaseAmount != null && String(effectiveBaseAmount) !== "0"
        ? effectiveBaseAmount
        : undefined;
    skills.push({
      id,
      name: asString(raw.name) ?? id,
      description: asString(raw.description),
      basePrice:
        rawBasePrice != null
          ? atomicToUsdc(rawBasePrice as string | number | bigint)
          : null,
      pricingModelDetail: parsePricingModel(metadata.pricingModel),
      variable:
        asBoolean(metadata.variablePricing) ||
        asBoolean(metadata.variable) ||
        (paymentRequired &&
          (asBoolean(servicePricing?.variablePricing) ||
            asBoolean(servicePricing?.variable))),
      paymentRequired,
      fulfillmentMode: asString(
        metadata.fulfillmentMode ?? extension?.fulfillmentMode,
      ) as FulfillmentMode,
      requiredFields: Array.isArray(metadata.requiredFields)
        ? metadata.requiredFields.filter(
            (field): field is string => typeof field === "string",
          )
        : null,
      requiresAssetOwnership: asBoolean(metadata.requiresAssetOwnership),
      requiresCapability: asBoolean(metadata.requiresCapability),
      assetType: asString(metadata.assetType),
    });
  }
  return skills;
}

function parsePricingModel(value: unknown): PublicSkillPricingModel | null {
  if (!value || typeof value !== "object") return null;
  const model = value as Record<string, unknown>;
  const kind = asString(model.kind);
  if (!kind) return null;
  return {
    kind,
    source: asString(model.source),
    hint: asString(model.hint),
  };
}

function formatServiceCardForPublic(
  provider: CachedProvider,
  card: ProviderCard,
  marketplace: MarketplaceLegalUrls,
): PublicService | null {
  const extension = extractMarketplaceExtension(card.agentCard);
  if (!extension || !provider.providerLegal) return null;
  const rawPricing = (extension.pricing ?? {}) as Record<string, unknown>;
  const rawBasePrice = rawPricing.baseAmount;
  const pricing: PublicServicePricing = {
    currency: asString(rawPricing.currency),
    basePrice:
      rawBasePrice != null
        ? atomicToUsdc(rawBasePrice as string | number | bigint)
        : null,
    pricingModel: asString(rawPricing.model),
    variable:
      asBoolean(rawPricing.variable) ||
      asBoolean(rawPricing.variablePricing),
    billingModel: asString(rawPricing.billingModel),
  };
  const primary = derivePrimaryServiceId({ ...provider, cards: [card] });
  return {
    agentId: provider.agentId.toString(),
    name: extractAgentCardName(card.agentCard),
    providerAddress: provider.walletAddress,
    agentURI: provider.agentURI,
    categoryFamily: extension.categoryFamily,
    serviceType: extension.serviceType,
    jurisdictions: extension.jurisdictions,
    serviceDescription: asString(extension.serviceDescription),
    serviceLifecycle: asString(extension.serviceLifecycle),
    turnaroundEstimate: asString(extension.turnaroundEstimate),
    providerA2AUrl: extractAgentCardUrl(card.agentCard),
    providerName: provider.providerName,
    providerDescription: provider.providerDescription,
    providerWebsite: provider.providerExternalUrl,
    iconUrl: provider.providerImage,
    legal: buildServiceLegal(marketplace, provider.providerLegal),
    serviceId: primary?.serviceId ?? null,
    serviceSlug: primary?.serviceSlug ?? null,
    serviceVersion: primary?.serviceVersion ?? null,
    pricing,
    skills: flattenSkills(card.agentCard),
  };
}

export function formatServicesForPublic(
  provider: CachedProvider,
  marketplace: MarketplaceLegalUrls,
): PublicService[] {
  const services: PublicService[] = [];
  for (const card of cardsOf(provider)) {
    const service = formatServiceCardForPublic(provider, card, marketplace);
    if (service) services.push(service);
  }
  return services;
}

export function formatChainActivityRow(
  row: import("../db/queries.js").ChainActivityRow,
  providerName: string | null,
  serviceName: string | null,
  buyerName: string | null,
): PublicActivityRow {
  const outcomeLabels: readonly TransactionOutcome[] = [
    "Completed",
    "Failed",
    "Canceled",
  ];
  const confirmationLabels: readonly BuyerConfirmationLabel[] = [
    "Pending",
    "Confirmed",
    "NotConfirmed",
  ];
  return {
    txHash: row.txHash,
    buyerAgentId: row.buyerAgentId.toString(),
    providerAgentId: row.providerAgentId.toString(),
    providerName,
    serviceName,
    serviceSlug: row.serviceSlug,
    serviceId: row.serviceId,
    buyerName,
    amount: atomicToUsdc(row.amountAtomic),
    skillId: row.skillId,
    timestamp: row.settledAt.toISOString(),
    outcome: row.outcomeCode != null ? outcomeLabels[row.outcomeCode] : null,
    confirmation: confirmationLabels[row.confirmationCode] ?? "Pending",
    fulfillmentSeconds: row.fulfillmentSeconds,
    refundedUsdc: atomicToUsdc(row.refundedAtomic),
    confirmationAttestationUid: row.confirmationAttestationUid,
  };
}
