import type { ServiceLegal } from "../legal/types.js";
import type {
  CategoryFamily,
  FulfillmentMode,
  ServiceType,
} from "../serviceTaxonomy.js";
import type { Hex } from "../types.js";

export interface PublicService {
  agentId: string;
  name: string;
  providerAddress: Hex;
  agentURI: string;
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions: string[];
  serviceDescription: string | null;
  serviceLifecycle: string | null;
  turnaroundEstimate: string | null;
  providerA2AUrl: string | null;
  providerName: string | null;
  providerDescription: string | null;
  providerWebsite: string | null;
  iconUrl: string | null;
  legal: ServiceLegal;
  serviceId: Hex | null;
  serviceSlug: string | null;
  serviceVersion: string | null;
  pricing: PublicServicePricing;
  skills: PublicSkill[];
}

export interface PublicServicePricing {
  currency: string | null;
  basePrice: string | null;
  pricingModel: string | null;
  variable: boolean;
  billingModel: string | null;
}

export interface PublicSkillPricingModel {
  kind: string;
  source: string | null;
  hint: string | null;
}

export interface PublicSkill {
  id: string;
  name: string;
  description: string | null;
  basePrice: string | null;
  pricingModelDetail: PublicSkillPricingModel | null;
  variable: boolean;
  paymentRequired: boolean;
  fulfillmentMode: FulfillmentMode;
  requiredFields: string[] | null;
  requiresAssetOwnership: boolean;
  requiresCapability: boolean;
  assetType: string | null;
}
