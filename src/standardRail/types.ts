import type { Hex } from "../types.js";

export type BindingProfile = "stock-fixed-v1" | "recipe-bound-v1" | "recipe-bound-v2";

export type StandardOrderState =
  | "DRAFT"
  | "CHALLENGE_ISSUED"
  | "ATTEMPT_OPENED"
  | "VERIFIED"
  | "VERIFY_REJECTED"
  | "SETTLE_INVOKED"
  | "FACILITATOR_CONFIRMED"
  | "SETTLEMENT_AMBIGUOUS"
  | "SETTLEMENT_FAILED"
  | "EXTERNAL_OR_UNPROVEN_DEPOSIT"
  | "DEPOSIT_FINAL"
  | "RELEASE_FINAL"
  | "DISPATCH_STARTED"
  | "DISPATCHED"
  | "DISPATCH_AMBIGUOUS"
  | "FULFILLED"
  | "PROVIDER_FAILED"
  | "INPUT_REQUIRED"
  | "LEGAL_HOLD"
  | "NOT_SETTLED";

export interface SignedEnvelope<T, Version extends number = 1> {
  artifactType: string;
  schemaVersion: Version;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  issuedAt: number;
  validBefore: number;
  payload: T;
  signature: Hex;
}

export interface ListingCommitmentV2 {
  canonicalToken: Hex;
  railCapabilityRequirementsHash: Hex;
  providerAgentId: string;
  serviceId: Hex;
  providerIdentitySnapshotHash: Hex;
  providerAuthorityKey: Hex;
  providerTerminalAttestationKey: Hex;
  providerPayee: Hex;
  providerControlProfileHash: Hex;
  outcomeId: string;
  method: "POST";
  absoluteResourceUri: string;
  bindingProfile: BindingProfile;
  requestSchemaHash: Hex;
  responseSchemaHash: Hex;
  canonicalizationProfile: "rfc8785-v1";
  buyerIdentityPolicyHash: Hex;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  termsHash: Hex;
  screeningPolicyHash: Hex;
  chainEvidencePolicyHash: Hex;
  extensionPolicyHash: Hex;
  listingEpoch: string;
  validFrom: number;
  validUntil: number;
  splitterFactory: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterCreationCodeHash: Hex;
  splitterDeploymentSalt: Hex;
}

export interface ListingEpochManifestV2 {
  chainId: number;
  canonicalToken: Hex;
  providerPayee: Hex;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  policyVersionHash: Hex;
  outcomeIdHash: Hex;
  listingEpoch: string;
  listingCommitmentHash: Hex;
  splitterAddress: Hex;
  splitterFactory: Hex;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterDeploymentSalt: Hex;
  splitterCreationCode: Hex;
  splitterCreationCodeHash: Hex;
  splitterInitCodeHash: Hex;
  splitterDeploymentTransaction: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterDeploymentTransactionIndex: number;
  splitterDeploymentLogIndex: number;
  splitterRuntimeCodeHash: Hex;
  splitterImmutableHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
}

export interface ProviderOutcomeOfferV1 {
  listingManifestHash: Hex;
  outcomeId: string;
  skillId: string;
  providerAgentId: string;
  providerPayee: Hex;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
  quotePolicyHash: Hex;
  capacityPolicyHash: Hex;
  deadlinePolicyHash: Hex;
  deliveryCommitment: Hex;
  termsHash: Hex;
  issuedAt: number;
  validBefore: number;
  offerNonce: Hex;
}

export interface ProviderControlProfileV1 {
  providerAgentId: string;
  providerAudience: string;
  origin: string;
  quoteUrl: string;
  dispatchUrl: string;
  dispatchStatusUrl: string;
  lifecycleUrl: string;
  assetQueryUrl: string;
  assetActionUrl: string;
  assetResponseKeyId: string;
  assetResponseKey: Hex;
  servicingProfileEpoch: number;
  tlsPolicy: "webpki-v1";
  workloadAuthentication: "signed-envelopes-v1";
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface ScreeningPolicyV1 {
  policyId: string;
  sanctionsOracle: Hex;
  sanctionsOracleRuntimeCodeHash: Hex;
  screenPayer: boolean;
  screenedRoles: string[];
  providerControlledWallets: Hex[];
}

export interface BuyerIdentityPolicyV1 {
  policyId: "none";
}

export interface ExtensionPolicyV1 {
  requiredExtensions: string[];
  optionalExtensions: string[];
}

export interface QuotePolicyV1 {
  maximumLifetimeSeconds: number;
  minimumPaymentWindowSeconds: number;
  personalizedPricing: false;
}

export interface DeliveryCommitmentV1 {
  deliveryMode: "asynchronous-v1";
  customerKyc: "provider-post-payment-v1";
  terminalAttestation: "provider-signed-v1";
  responseValidation: "closed-schema-v1";
}

/**
 * Plain-data views of one purchasable listing, preserving the historical
 * field paths the purchase flow reads. Assembled at checkout time from the
 * service-registration store — never parsed from a sealed env manifest —
 * so these members are NOT signed envelopes; the cryptographic authorities
 * are the registration-store artifacts (gateway-signed preparation, the
 * provider-signed intent, the runtime commitment) referenced by the
 * top-level hashes.
 */
export interface ListingCommitmentView {
  canonicalToken: Hex;
  providerAgentId: string;
  serviceId: Hex;
  providerAuthorityKey: Hex;
  providerTerminalAttestationKey: Hex;
  providerPayee: Hex;
  providerControlProfileHash: Hex;
  outcomeId: string;
  absoluteResourceUri: string;
  bindingProfile: BindingProfile;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  listingEpoch: string;
  splitterFactory: Hex;
}

export interface ListingSplitterView {
  splitterAddress: Hex;
  splitterFactory: Hex;
  splitterDeploymentTransaction: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
  outcomeIdHash: Hex;
  listingCommitmentHash: Hex;
  policyVersionHash: Hex;
  listingEpoch: string;
}

export interface ListingOfferView {
  outcomeId: string;
  skillId: string;
  providerAgentId: string;
  providerPayee: Hex;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
}

export interface StandardListing {
  registrationId: string;
  listingId: string;
  listingKey: Hex;
  /** recipe-bound-v2 deal-document slots (Option A). */
  runtimeCommitmentHash: Hex;
  providerIntentHash: Hex;
  /** Finalized chain identities from the registration record. */
  providerOwner: Hex;
  providerAgentWallet: Hex;
  commitment: { payload: ListingCommitmentView };
  manifest: { payload: ListingSplitterView };
  offer: { payload: ListingOfferView };
  providerControlProfile: SignedEnvelope<ProviderControlProfileV1>;
  discovery: {
    categoryFamily: string;
    serviceType: string;
    jurisdictions: string[];
    tags: string[];
    persistentAsset: boolean;
  };
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  terms: {
    marketplaceTermsUrl: string;
    marketplacePrivacyUrl: string;
    providerLegalName: string;
    providerTermsUrl: string;
    providerPrivacyUrl: string;
  };
  screeningPolicy: ScreeningPolicyV1;
  buyerIdentityPolicy: BuyerIdentityPolicyV1;
  extensionPolicy: ExtensionPolicyV1;
  quotePolicy: QuotePolicyV1 | null;
  deliveryCommitment: DeliveryCommitmentV1;
  capacityPolicy: {
    maxOpenOrders: number;
  };
  deadlinePolicy: {
    draftSeconds: number;
    minimumPaymentWindowSeconds: number;
    verificationSeconds: number;
    settlementEvidenceSeconds: number;
    releaseEvidenceSeconds: number;
    dispatchSeconds: number;
    fulfillmentSeconds: number;
  };
}

export interface PublicMarketplacePurchaseV1 {
  orderKey: Hex;
  txHash: Hex | null;
  payer: Hex;
  buyerAgentId: string | null;
  buyerName: string | null;
  amount: string;
  outcomeId: string;
  timestamp: string;
}

export interface PublicReputationV1 {
  transactionCount: string;
  completedCount: string;
  failedCount: string;
  canceledCount: string;
  completionSampleSize: string;
  completionRate: number | null;
  confirmedCount: string;
  notConfirmedCount: string;
  confirmationSampleSize: string;
  buyerSatisfactionRate: number | null;
  valueWeightedBuyerSatisfactionRate: number | null;
  totalPaid: string;
  totalRefunded: string;
  averageFulfillmentSeconds: number | null;
  fulfillmentSampleSize: string;
  recentPurchases: PublicMarketplacePurchaseV1[];
  safeBlock: string | null;
}

export interface PublicOutcomeV1 {
  providerAgentId: string;
  serviceId: Hex;
  outcomeId: string;
  skillId: string;
  categoryFamily: string;
  serviceType: string;
  jurisdictions: string[];
  tags: string[];
  persistentAsset: boolean;
  bindingProfile: BindingProfile;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
  token: Hex;
  payTo: Hex;
  splitterDeploymentBlockNumber: string;
  providerPayee: Hex;
  daskiCommissionReceiver: Hex;
  commissionBps: number;
  providerAudience: string;
  absoluteResourceUri: string;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  runtimeCommitmentHash: Hex;
  providerIntentHash: Hex;
  splitter: ListingSplitterView;
  terms: StandardListing["terms"];
  deadlinePolicy: StandardListing["deadlinePolicy"];
  capacityPolicy: StandardListing["capacityPolicy"];
  service: {
    id: Hex;
    slug: string;
    version: string;
    name: string;
    description: string;
    categoryFamily: string;
    serviceType: string;
    jurisdictions: string[];
    turnaroundEstimate: string;
    serviceLifecycle: string;
    agentCardUrl: string;
    providerA2AUrl: string;
  };
  skill: {
    id: string;
    name: string;
    description: string;
    tags: string[];
  };
  providerReputation: PublicReputationV1;
  serviceReputation: PublicReputationV1;
  reputation: PublicReputationV1;
}

export interface PublicOutcomeDetailV1 extends PublicOutcomeV1 {
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  artifacts: {
    runtimeCommitment: Hex;
    preparation: Hex;
    providerIntent: Hex;
  };
}

export interface PublicChainMetadataV3 {
  version: 3;
  outcomeSchemaVersion: 1;
  chainId: number;
  network: string;
  paymentRail: {
    scheme: "exact";
    network: string;
    asset: Hex;
    transferMethod: "eip3009";
    activeRailProfileHash: Hex;
    activeRailProfileUrl: string;
  };
  contracts: {
    identityRegistry: Hex;
    agentIndex: Hex;
    providerRegistry: Hex;
    serviceRegistry: Hex;
    validationRegistry: Hex;
    reputationStorage: Hex;
    eas: Hex;
    usdc: Hex;
  };
  outcomes: PublicOutcomeV1[];
}

export interface ActiveRailProfileV1 {
  railEpoch: string;
  facilitatorProfileHash: Hex;
  priorRailEpoch: string;
  priorActiveRailProfileHash: Hex;
  environment: string;
  chainId: number;
  activatedAt: number;
  admissionValidBefore: number;
  recoveryValidBefore: number;
}

export interface FacilitatorProfileV1 {
  profileEpoch: string;
  profileId: string;
  baseUrl: string;
  scheme: "exact";
  network: string;
  asset: Hex;
  assetTransferMethod: "eip3009";
  authenticationMethod: "cdp-jwt-v1";
  credentialPolicyHash: Hex;
  tlsPolicyHash: Hex;
  allowedExtensionSetHash: Hex;
  settlementCalldataPolicyHash: Hex;
  verifyTimeout: number;
  settleTimeout: number;
  responseSchemaHash: Hex;
  screeningPolicyHash: Hex;
  evidenceAdapterHash: Hex;
  activatedAt: number;
  admissionValidBefore: number;
  recoveryValidBefore: number;
}

export interface RailCapabilityRequirementsV1 {
  requirementId: string;
  scheme: "exact";
  network: string;
  asset: Hex;
  assetTransferMethod: "eip3009";
  authenticatedResponseEvidence: "cdp-jwt-v1";
  screeningCoverage: "gateway-and-facilitator-v1";
  calldataSemantics: "transferWithAuthorization-v1";
  allowedExtensionSetHash: Hex;
}

export interface ChainEvidencePolicyV2 {
  policyId: string;
  canonicalToken: Hex;
  canonicalTokenRuntimeCodeHash: Hex;
  tokenImplementationAddress: Hex;
  tokenImplementationRuntimeCodeHash: Hex;
  tokenImplementationSlot: Hex;
  tokenDomainSeparator: Hex;
  maximumSourceLagBlocks: number;
  finalityBlockTimeSeconds: number;
  maximumLogPageEvents: number;
}

export interface QuoteV1 {
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  providerQuoteHash: Hex;
  canonicalRequestHash: Hex;
  grossAmount: string;
  token: Hex;
  splitter: Hex;
  orderNonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface StandardRailReceiptV2 {
  orderId: string;
  state: "RELEASE_FINAL";
  payer: Hex;
  providerAgentId: string;
  outcomeId: string;
  bindingProfile: BindingProfile;
  activeRailProfileHash: Hex;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  authorizationKey: Hex;
  paymentPayloadHash: Hex;
  grossAmount: string;
  providerNetAmount: string;
  daskiCommissionAmount: string;
  facilitatorConfirmationHash: Hex;
  settlementTxHash: Hex;
  depositEvidenceHash: Hex;
  depositBlockNumber: string;
  depositBlockHash: Hex;
  depositTransactionIndex: number;
  depositLogIndex: number;
  releaseTxHash: Hex;
  releaseEvidenceHash: Hex;
  releaseBlockNumber: string;
  releaseBlockHash: Hex;
  releaseTransactionIndex: number;
  releaseLogIndex: number;
  releaseSequence: string;
}

export interface StandardEvidenceBundleV2 {
  deposit: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
  release: {
    transactionHash: Hex;
    blockNumber: string;
    blockHash: Hex;
    transactionIndex: number;
    logIndex: number;
    releaseSequence: string;
    evidenceHash: Hex;
    canonicalEvidence: Record<string, unknown>;
    sources: string[];
  };
}

export interface StandardRailDispatchV2 {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAudience: string;
  providerControlProfileHash: Hex;
  orderId: string;
  orderKey: Hex;
  serviceId: Hex;
  reputationEligible: boolean;
  reputationContract: Hex;
  outcomeSchemaUid: Hex;
  dispatchNonce: Hex;
  payer: Hex;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  quoteHash: Hex;
  bindingProfile: BindingProfile;
  canonicalRequestHash: Hex;
  orderNonce: Hex;
  buyerIdentityProofHash: Hex;
  activeRailProfileHash: Hex;
  facilitatorConfirmationHash: Hex;
  settlementTxHash: Hex;
  depositEvidenceHash: Hex;
  depositBlockNumber: string;
  depositBlockHash: Hex;
  depositTransactionIndex: number;
  depositLogIndex: number;
  releaseTxHash: Hex;
  releaseEvidenceHash: Hex;
  releaseBlockNumber: string;
  releaseBlockHash: Hex;
  releaseTransactionIndex: number;
  releaseLogIndex: number;
  releaseSequence: string;
  grossAmount: string;
  providerNetAmount: string;
  daskiCommissionAmount: string;
  canonicalProviderRequestHash: Hex;
  dispatchDeadlineSeconds: number;
  issuedAt: number;
  validBefore: number;
}

export interface DispatchStatusQueryV1 {
  orderId: string;
  dispatchHash: Hex;
  issuedAt: number;
  validBefore: number;
}

/**
 * The deployment-owned GLOBAL rail-policy bundle: schema-independent signed
 * envelopes shared by every listing. Listings themselves live in the
 * service-registration database — the sealed manifest no longer carries a
 * listing array. The retained provider control profiles supply the dispatch
 * transport contract (endpoints, audience, bounds) per provider.
 */
export interface StandardRailManifest {
  facilitatorProfile: SignedEnvelope<FacilitatorProfileV1>;
  railCapabilityRequirements: SignedEnvelope<RailCapabilityRequirementsV1>;
  activeRailProfile: SignedEnvelope<ActiveRailProfileV1>;
  chainEvidencePolicy: SignedEnvelope<ChainEvidencePolicyV2, 2>;
  servicingAdmissions: SignedEnvelope<ProviderServicingAdmissionV1>[];
  actionCatalogs: SignedEnvelope<ProviderAssetActionCatalogV1>[];
  providerControlProfiles: SignedEnvelope<ProviderControlProfileV1>[];
}


export interface StandardOrderRecord {
  orderId: string;
  orderKey: Hex;
  handleHash: Buffer;
  state: StandardOrderState;
  providerAgentId: string;
  outcomeId: string;
  bindingProfile: BindingProfile;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  listing: StandardListing;
  quoteHash: Hex;
  quote: SignedEnvelope<QuoteV1>;
  canonicalRequestHash: Hex;
  canonicalRequest: unknown;
  orderNonce: Hex;
  authorizationKey: Hex | null;
  paymentPayloadHash: Hex | null;
  payer: Hex | null;
  grossAmount: string;
  providerNetAmount: string | null;
  daskiCommissionAmount: string | null;
  encryptedPaymentPayload: Buffer | null;
  settlementTxHash: Hex | null;
  depositEvidenceHash: Hex | null;
  releaseTxHash: Hex | null;
  releaseEvidenceHash: Hex | null;
  providerTaskId: string | null;
  railEpoch: string;
  version: number;
  leaseFence: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletActionAuthorizationV1 {
  payer: Hex;
  providerAgentId: string;
  serviceId: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionDefinitionHash: Hex;
  actionCatalogEpoch: number;
  actionHash: Hex;
  methodHash: Hex;
  absoluteResourceUriHash: Hex;
  requestHash: Hex;
  audienceHash: Hex;
  nonce: Hex;
  issuedAt: number;
  validBefore: number;
}

export interface WalletAuthorizationTransport {
  message: WalletActionAuthorizationV1;
  signature: Hex;
}

export interface ProviderServicingAdmissionV1 {
  providerAgentId: string;
  providerControlProfileHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  servicingEnabled: boolean;
  previousAdmissionHash: Hex;
  validFrom: number;
  validBefore: number;
}

export interface ProviderIdentitySnapshotV1 {
  providerAgentId: string;
  serviceId: Hex;
  identityRegistry: Hex;
  providerRegistry: Hex;
  serviceRegistry: Hex;
  providerOwner: Hex;
  providerAgentWallet: Hex;
  providerPayee: Hex;
  blockNumber: string;
  blockHash: Hex;
}

export interface AssetActionDefinitionV1 {
  providerAgentId: string;
  serviceId: Hex;
  serviceSlug: string;
  actionId: string;
  assetType: string;
  ownershipPolicy: "owner-only";
  destructive: boolean;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  confirmationSummarySchema: Record<string, unknown> | null;
  confirmationSummaryTemplate: Record<string, unknown> | null;
  endpoint: string;
  replayPolicy: "stable-result" | "regenerate-ephemeral" | "redacted-after-window";
  retentionSeconds: number;
  validFrom: number;
  validBefore: number;
  actionDefinitionHash: Hex;
}

export interface ProviderAssetActionCatalogV1 {
  providerAgentId: string;
  providerControlProfileHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actions: AssetActionDefinitionV1[];
}

export interface ProviderWalletActionGrantV1 {
  payer: Hex;
  providerAgentId: string;
  serviceId: Hex;
  actionHash: Hex;
  methodHash: Hex;
  absoluteResourceUriHash: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  gatewayAudienceHash: Hex;
  providerAudienceHash: Hex;
  grantNonce: Hex;
}

export interface ProviderAssetQueryResponseV1 {
  providerAgentId: string;
  payer: Hex;
  assets: Array<{
    providerAssetId: string;
    serviceSlug: string;
    type: string;
    identifier: string;
    status: string;
    createdAt: string;
    expiresAt: string | null;
  }>;
  nextCursor: string | null;
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
}

export interface ProviderAssetActionResponseV1 {
  providerAgentId: string;
  payer: Hex;
  actionExecutionId: Hex;
  status: "completed" | "failed";
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
  result: Record<string, unknown> | null;
  errorClass: string | null;
}

export interface ProviderAssetActionStageResponseV1 {
  providerAgentId: string;
  payer: Hex;
  actionExecutionId: Hex;
  status: "staged" | "canceled";
  effectSummary: Record<string, unknown>;
  confirmationHash: Hex;
  earliestExecutionAt: number;
  stageValidBefore: number;
  responseNonce: Hex;
  requestHash: Hex;
  walletAuthorizationHash: Hex;
  grantHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  servicingProfileEpoch: number;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
}
