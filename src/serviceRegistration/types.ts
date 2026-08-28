import type { Address, Hex } from "viem";
import type { SignedEnvelope } from "../standardRail/types.js";

export interface ProviderServiceRegistrationIntentV1 {
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  providerPayee: Address;
  serviceContractHash: Hex;
  skillContractSetHash: Hex;
  skills: Array<{
    skillId: string;
    skillContractHash: Hex;
  }>;
  railPolicyHash: Hex;
  registrationNonce: Hex;
}

export type ProviderServiceRegistrationIntentEnvelope =
  SignedEnvelope<ProviderServiceRegistrationIntentV1>;

export interface ProviderServiceRegistrationEvidenceV1 {
  registrationId: string;
  preparedRegistrationHash: Hex;
  expectedState: "PREPARED" | "EVIDENCE_PENDING";
  splitterTransactionHashes: Array<{
    listingId: string;
    transactionHash: Hex;
  }>;
  evidenceNonce: Hex;
}

export type ProviderServiceRegistrationEvidenceEnvelope =
  SignedEnvelope<ProviderServiceRegistrationEvidenceV1>;

export interface PublishedServiceLegal {
  marketplaceTermsUrl: string;
  marketplacePrivacyUrl: string;
  providerLegalName: string;
  providerTermsUrl: string;
  providerPrivacyUrl: string;
}

export interface PublishedAssetActionContract {
  ownershipPolicy: "owner-only";
  effect: "read" | "mutate" | "destructive";
  replayPolicy:
    | "stable-result"
    | "regenerate-ephemeral"
    | "redacted-after-window";
  retentionSeconds: number;
  confirmationSummarySchema?: Record<string, unknown>;
  confirmationSummaryTemplate?: Record<string, unknown>;
}

export interface PublishedSkillContract {
  skillId: string;
  skillContractHash: Hex;
  /**
   * Mutable availability, deliberately OUTSIDE the hashed contract: a
   * provider pauses or resumes a skill through card refresh without minting
   * a new listing version or splitter.
   */
  acceptingNewOrders: boolean;
  presentation: {
    name: string;
    description: string;
    examples: string[];
    tags: string[];
    documentationUrl: string;
  };
  contract: {
    inputSchema: Record<string, unknown>;
    resultSchema: Record<string, unknown>;
    pricing: Record<string, unknown>;
    paymentRequired: boolean;
    requiresAssetOwnership: boolean;
    assetType: string | null;
    fulfillmentMode: "automated" | "human" | "hybrid";
    capacity: { maxOpenOrders: number };
    deadlines: Record<string, unknown>;
    assetAction: PublishedAssetActionContract | null;
  };
}

export interface ProviderServiceCard {
  name: string;
  description: string;
  providerAgentId: string;
  service: {
    serviceId: Hex | null;
    slug: string;
    version: string;
    categoryFamily: string;
    serviceType: string;
    jurisdictions: string[];
    lifecycle: string;
    turnaroundEstimate: string;
    acceptingNewOrders: boolean;
  };
  standardRail: {
    origin: string;
    providerAudience: string;
    quoteUrl: string;
    dispatchUrl: string;
    dispatchStatusUrl: string;
    lifecycleUrl: string;
    assetQueryUrl: string;
    assetActionUrl: string;
  };
  legal: PublishedServiceLegal;
  serviceContractHash: Hex;
  skillContractSetHash: Hex;
  skills: PublishedSkillContract[];
}

export interface GatewayListingPreparationV1 {
  registrationId: string;
  listingId: string;
  listingKey: Hex;
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  skillId: string;
  skillContractHash: Hex;
  skillContractSetHash: Hex;
  providerIntentHash: Hex;
  canonicalToken: Address;
  providerPayee: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  splitterFactory: Address;
  splitterDeploymentSalt: Hex;
  policyVersionHash: Hex;
  listingEpoch: string;
}

export interface GatewaySkillControlProfileV1 {
  registrationId: string;
  providerAgentId: string;
  providerIntentHash: Hex;
  serviceId: Hex;
  serviceSlug: string;
  skillId: string;
  skillContractHash: Hex;
  policyVersionHash: Hex;
  providerEndpoint: string;
  ownershipPolicy: "owner-only";
  effect: "read" | "mutate" | "destructive";
  replayPolicy:
    | "stable-result"
    | "regenerate-ephemeral"
    | "redacted-after-window";
  retentionSeconds: number;
  walletAuthorizationRequired: true;
  delayedConfirmationRequired: boolean;
  confirmationSummarySchemaHash: Hex | null;
  confirmationSummaryTemplateHash: Hex | null;
}

export interface PreparedChainTransaction {
  kind: "splitter-deployment";
  listingId: string | null;
  to: Address;
  data: Hex;
  value: "0";
}

export interface PreparedListing {
  listingId: string;
  listingKey: Hex;
  skillId: string;
  skillContractHash: Hex;
  paymentRequired: boolean;
  acceptingNewOrders: boolean;
  deploymentRequired: boolean;
  reused: boolean;
  splitterAddress: Address | null;
  preparation: SignedEnvelope<GatewayListingPreparationV1> | null;
  controlProfile: SignedEnvelope<GatewaySkillControlProfileV1> | null;
  transaction: PreparedChainTransaction | null;
}

export interface PreparedServiceRegistration {
  registrationId: string;
  state:
    | "PREPARED"
    | "EVIDENCE_PENDING"
    | "ACTIVE"
    | "SUPERSEDED"
    | "REJECTED";
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  serviceVersion: string;
  agentCardUrl: string;
  serviceWallet: Address;
  providerPayee: Address;
  providerIntentHash: Hex;
  railPolicyHash: Hex;
  marketplaceEnabled: boolean;
  listings: PreparedListing[];
}
