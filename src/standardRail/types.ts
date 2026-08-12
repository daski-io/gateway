import type { Hex } from "../types.js";

export type BindingProfile = "stock-fixed-v1" | "recipe-bound-v1";

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
  | "KYC_REQUIRED"
  | "LEGAL_HOLD"
  | "REFUND_DUE"
  | "REFUND_RESERVED"
  | "REFUND_INVOKED"
  | "REFUND_AMBIGUOUS"
  | "REFUNDED"
  | "NO_REFUND";

export interface SignedEnvelope<T> {
  artifactType: string;
  schemaVersion: 1;
  environment: string;
  chainId: number;
  audience: string;
  signerKeyId: string;
  issuedAt: number;
  validBefore: number;
  payload: T;
  signature: Hex;
}

export interface ListingCommitmentV1 {
  canonicalToken: Hex;
  railCapabilityRequirementsHash: Hex;
  providerAgentId: string;
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
  refundPolicyHash: Hex;
  screeningPolicyHash: Hex;
  chainEvidencePolicyHash: Hex;
  extensionPolicyHash: Hex;
  listingEpoch: string;
  validFrom: number;
  validUntil: number;
  splitterFactory: Hex;
  splitterCreationCodeHash: Hex;
  splitterDeploymentSalt: Hex;
}

export interface ListingEpochManifestV1 {
  listingCommitmentHash: Hex;
  splitterAddress: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterImmutableHash: Hex;
  splitterDeploymentTransaction: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
}

export interface ProviderOutcomeOfferV1 {
  listingManifestHash: Hex;
  outcomeId: string;
  providerAgentId: string;
  providerPayee: Hex;
  pricingMode: "fixed" | "dynamic";
  fixedGrossAmount: string;
  quotePolicyHash: Hex;
  capacityPolicyHash: Hex;
  deadlinePolicyHash: Hex;
  deliveryCommitment: Hex;
  termsHash: Hex;
  refundPolicyHash: Hex;
  issuedAt: number;
  validBefore: number;
  offerNonce: Hex;
}

export interface ProviderControlProfileV1 {
  providerAgentId: string;
  providerAudience: string;
  origin: string;
  quoteUrl: string;
  reserveUrl: string;
  dispatchUrl: string;
  dispatchStatusUrl: string;
  lifecycleUrl: string;
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

export interface StandardListing {
  commitment: SignedEnvelope<ListingCommitmentV1>;
  manifest: SignedEnvelope<ListingEpochManifestV1>;
  offer: SignedEnvelope<ProviderOutcomeOfferV1>;
  providerControlProfile: SignedEnvelope<ProviderControlProfileV1>;
  title: string;
  description: string;
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
    refundSeconds: number;
  };
  refundPolicy: {
    buyerRequested: boolean;
    requestDeadlineSeconds: number;
    executionReserveAddress: Hex;
    releaseFailureDisposition: "legal_hold";
    providerFailureDisposition: "refund_due";
    dispatchAmbiguityDisposition: "refund_due";
    kycFailureDisposition: "refund_due";
  };
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

export interface FacilitatorCredentialBindingV1 {
  credentialEpoch: string;
  facilitatorProfileHash: Hex;
  credentialKeyIdHash: Hex;
  authenticationMethod: "cdp-jwt-v1";
  workloadIdentityHash: Hex;
  priorCredentialBindingHash: Hex;
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

export interface ChainEvidencePolicyV1 {
  policyId: string;
  canonicalToken: Hex;
  canonicalTokenRuntimeCodeHash: Hex;
  tokenImplementationAddress: Hex;
  tokenImplementationRuntimeCodeHash: Hex;
  tokenImplementationSlot: Hex;
  tokenDomainSeparator: Hex;
  maximumSourceLagBlocks: number;
  finalityBlockTimeSeconds: number;
  maximumIntervalEvents: number;
}

export interface RuntimeReleaseManifestV1 {
  runtimeEpoch: string;
  gatewayReleaseDigest: Hex;
  containerOrBinaryDigest: Hex;
  databaseSchemaVersion: "031_standard_rail.sql";
  canonicalConfigurationHash: Hex;
  activeRailProfileHash: Hex;
  facilitatorCredentialBindingHash: Hex;
  chainEvidencePolicyHash: Hex;
  activeListingManifestSetHash: Hex;
  providerControlProfileSetHash: Hex;
  adapterArtifactSetHash: Hex;
  keyPolicySetHash: Hex;
  environment: string;
  chainId: number;
  issuedAt: number;
  admissionValidBefore: number;
  recoveryValidBefore: number;
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

export interface StandardRailDispatchV1 {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  providerAudience: string;
  providerControlProfileHash: Hex;
  orderId: string;
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
  depositEvidenceHash: Hex;
  releaseEvidenceHash: Hex;
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

export interface StandardRailManifest {
  facilitatorProfile: SignedEnvelope<FacilitatorProfileV1>;
  facilitatorCredentialBinding: SignedEnvelope<FacilitatorCredentialBindingV1>;
  railCapabilityRequirements: SignedEnvelope<RailCapabilityRequirementsV1>;
  activeRailProfile: SignedEnvelope<ActiveRailProfileV1>;
  chainEvidencePolicy: SignedEnvelope<ChainEvidencePolicyV1>;
  runtimeRelease: SignedEnvelope<RuntimeReleaseManifestV1>;
  listings: StandardListing[];
}

export interface Eip3009Payload {
  x402Version: 2;
  accepted: {
    scheme: "exact";
    network: string;
    asset: Hex;
    amount: string;
    payTo: Hex;
    maxTimeoutSeconds: number;
    extra: {
      assetTransferMethod: "eip3009";
      name: string;
      version: string;
    };
  };
  payload: {
    signature: Hex;
    authorization: {
      from: Hex;
      to: Hex;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: Hex;
    };
  };
  extensions?: Record<string, unknown>;
}

export interface StandardOrderRecord {
  orderId: string;
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
  attachmentSetHash: Hex | null;
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
  runtimeEpoch: string;
  railEpoch: string;
  version: number;
  leaseFence: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StandardAttachmentRef {
  objectId: string;
  contentHash: Hex;
  byteSize: number;
  mediaType: string;
  expiresAt: number;
}
