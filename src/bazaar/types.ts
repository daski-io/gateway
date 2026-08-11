import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { Hex } from "../types.js";

export interface ListingOfferV1 {
  chainId: bigint;
  listingEpoch: Hex;
  listingCommitment: Hex;
  providerAgentId: bigint;
  offerSigner: Hex;
  fulfillmentSigner: Hex;
  providerPayee: Hex;
  outcomeId: Hex;
  methodHash: Hex;
  resourceHash: Hex;
  requestSchemaHash: Hex;
  responseSchemaHash: Hex;
  requestBindingModeHash: Hex;
  routeModeHash: Hex;
  token: Hex;
  grossAmount: bigint;
  payTo: Hex;
  paymentMaxTimeoutSeconds: bigint;
  daskiCommissionReceiver: Hex;
  commissionBps: bigint;
  splitterCodeHash: Hex;
  termsHash: Hex;
  policyVersion: Hex;
  offerId: Hex;
  issuedAt: bigint;
  validBefore: bigint;
}

export interface SignedListingOfferV1 {
  message: ListingOfferV1;
  signature: Hex;
}

export interface PayToControlProofV1 {
  validBefore: bigint;
  signature: Hex;
}

export interface FulfillmentSignerControlProofV1 {
  validBefore: bigint;
  signature: Hex;
}

export interface BazaarListing {
  routePath: string;
  resourceUrl: string;
  description: string;
  sellerName: string;
  expectedDelivery: string;
  refundTerms: string;
  termsUrl: string;
  termsDocumentHash: Hex;
  termsDocumentMediaType: "text/markdown; charset=utf-8";
  termsDocumentBase64: string;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  assetName: string;
  assetVersion: string;
  listingEpoch: Hex;
  listingCommitment: Hex;
  termsHash: Hex;
  policyVersion: Hex;
  payToControlProof: PayToControlProofV1;
  fulfillmentSignerControlProof: FulfillmentSignerControlProofV1;
  offer: SignedListingOfferV1;
}

export interface FacilitatorCallResult<T> {
  response: T;
  extensionResponses: string | null;
}

export interface BazaarFacilitatorClient {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signal: AbortSignal,
  ): Promise<FacilitatorCallResult<VerifyResponse>>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signal: AbortSignal,
  ): Promise<FacilitatorCallResult<SettleResponse>>;
}

export interface SettlementEvidenceInput {
  transaction: Hex;
  chainId: bigint;
  token: Hex;
  payer: Hex;
  nonce: Hex;
  payTo: Hex;
  grossAmount: bigint;
}

export interface SettlementEvidenceVerifier {
  verify(input: SettlementEvidenceInput, signal: AbortSignal): Promise<SettlementEvidenceInput & {
    finalized: true;
    authorizationUsedEventCount: 1;
    matchingTransferEventCount: 1;
  }>;
}

export interface BazaarSettlementObservationInput {
  orderRecordId: Hex;
  authorizationDigest: Hex;
  chainId: bigint;
  token: Hex;
  payer: Hex;
  nonce: Hex;
  payTo: Hex;
  grossAmount: bigint;
  authorizationValidBefore: bigint;
  requiredObservedThrough: bigint;
}

export type BazaarSettlementObservationResult =
  | { kind: "pending" }
  | {
      kind: "no_transfer";
      observedThrough: bigint;
      evidenceHash: Hex;
      chainId: bigint;
      token: Hex;
      payer: Hex;
      nonce: Hex;
      payTo: Hex;
      grossAmount: bigint;
    }
  | {
      kind: "matching_transfer";
      observedThrough: bigint;
      evidenceHash: Hex;
      transaction: Hex;
      blockHash: Hex;
      chainId: bigint;
      token: Hex;
      payer: Hex;
      nonce: Hex;
      payTo: Hex;
      grossAmount: bigint;
      transactionIndex: number;
      authorizationLogIndex: number;
      transferLogIndex: number;
      finalized: true;
      authorizationUsedEventCount: 1;
      matchingTransferEventCount: 1;
    };

export interface BazaarSettlementObserver {
  observe(
    input: BazaarSettlementObservationInput,
    signal: AbortSignal,
  ): Promise<BazaarSettlementObservationResult>;
}

export interface BazaarSettlementObservationPolicy {
  finalityWindowSeconds: number;
  retryDelaySeconds: number;
}

export interface BazaarPayerProfileVerifier {
  verifyBeforeSettlement(input: {
    chainId: bigint;
    payer: Hex;
  }, signal: AbortSignal): Promise<{
    chainId: bigint;
    payer: Hex;
    profile: "eoa" | "unsupported";
  }>;
}

export interface BazaarDispatchInput {
  orderRecordId: Hex;
  orderHandle: string;
  providerAgentId: bigint;
  payer: Hex;
  buyerAuthorizationDigest: Hex;
  outcomeId: Hex;
  listingCommitment: Hex;
  requestHash: Hex;
  settlementTransaction: Hex;
}

export type BazaarRefundReason =
  | "AMBIGUOUS_PAID"
  | "SETTLEMENT_EVIDENCE_INVALID"
  | "SPLIT_OR_TOKEN_FAILURE"
  | "PROVIDER_COMPLIANCE_FAILURE"
  | "PROVIDER_FULFILLMENT_FAILURE"
  | "DISPUTE_APPROVED";

export type BazaarDispatchResult =
  | { kind: "accepted"; orderRecordId: Hex; taskId: string }
  | {
      kind: "rejected";
      orderRecordId: Hex;
      reason: Extract<BazaarRefundReason,
        "PROVIDER_COMPLIANCE_FAILURE" | "PROVIDER_FULFILLMENT_FAILURE">;
    };

export interface BazaarFulfillmentService {
  dispatch(input: BazaarDispatchInput, signal: AbortSignal): Promise<BazaarDispatchResult>;
  performLifecycleAction(
    input: BazaarLifecycleDispatchInput,
    signal: AbortSignal,
  ): Promise<{
    assertionNonce: Hex;
    result: Record<string, unknown>;
  }>;
}

export type BazaarFulfillmentOutcome =
  | "FULFILLED"
  | "PROVIDER_COMPLIANCE_FAILURE"
  | "PROVIDER_FULFILLMENT_FAILURE";

export interface BazaarFulfillmentAttestationMessage {
  orderRecordId: Hex;
  taskIdHash: Hex;
  providerAgentId: string;
  listingCommitment: Hex;
  authorizationDigest: Hex;
  outcomeId: Hex;
  requestHash: Hex;
  settlementTransaction: Hex;
  outcomeHash: Hex;
  evidenceHash: Hex;
  evidenceId: Hex;
}

export interface BazaarFulfillmentObservationInput {
  orderRecordId: Hex;
  taskId: string;
  taskIdHash: Hex;
  providerAgentId: bigint;
  listingCommitment: Hex;
  authorizationDigest: Hex;
  outcomeId: Hex;
  requestHash: Hex;
  settlementTransaction: Hex;
  chainId: bigint;
  payTo: Hex;
}

export interface BazaarFulfillmentObserver {
  observe(
    input: BazaarFulfillmentObservationInput,
    signal: AbortSignal,
  ): Promise<
    | { kind: "pending" }
    | {
        kind: "attested";
        message: BazaarFulfillmentAttestationMessage;
        signature: Hex;
      }
  >;
}

export interface BazaarFulfillmentObservationPolicy {
  retryDelaySeconds: number;
}

export type BazaarLifecycleAction =
  | "ORDER_STATUS"
  | "ARTIFACT_GET"
  | "SUPPORT_MESSAGE";

export interface BazaarLifecycleDispatchInput {
  taskId: string | null;
  action: BazaarLifecycleAction;
  request: Record<string, unknown>;
  contentTrust: "none" | "untrusted_buyer";
  assertion: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: "DaskiBazaarLifecycleAction";
    message: BazaarProviderLifecycleSigningRequest["message"];
    signature: Hex;
  };
}

export interface BazaarProviderLifecycleSigningRequest {
  chainId: string;
  payTo: Hex;
  message: {
    orderRecordId: Hex;
    taskIdHash: Hex;
    providerAgentId: string;
    actionHash: Hex;
    requestHash: Hex;
    buyerAuthorizationDigest: Hex;
    nonce: Hex;
    issuedAt: string;
    expiresAt: string;
  };
}

export interface BazaarProviderActionSigningBroker {
  address: Hex;
  signLifecycleAction(
    input: BazaarProviderLifecycleSigningRequest,
    signal: AbortSignal,
  ): Promise<Hex>;
}

export interface BazaarChallengeMacKey {
  epoch: string;
  secret: Buffer;
}

export interface BazaarRetainedChallengeMacKey extends BazaarChallengeMacKey {
  acceptUntil: bigint;
}

export interface BazaarChallengeMacKeyring {
  current: BazaarChallengeMacKey;
  retained?: BazaarRetainedChallengeMacKey[];
}

export interface BazaarSettlementCapacityPolicy {
  maxGlobalConcurrent: number;
  maxPerProviderConcurrent: number;
  maxPerListingConcurrent: number;
  maxPerPayerConcurrent: number;
  maxGlobalPerMinute: number;
  maxPerProviderPerMinute: number;
  maxPerListingPerMinute: number;
  maxPerPayerPerMinute: number;
}

export interface BazaarRefundRiskPolicy {
  assurance: "contractual-only" | "prefunded-reserve" | "bonded";
  refundWallet: Hex;
  maxSingleGross: bigint;
  maxAggregateReserved: bigint;
  maxAggregatePaidUnfulfilled: bigint;
  maxAggregateRefundDue: bigint;
  refundSlaSeconds: number;
}

export interface BazaarRefundWorkerPolicy {
  instructionTtlSeconds: number;
  retryDelaySeconds: number;
}

export interface BazaarRefundInstructionSigningRequest {
  chainId: string;
  payTo: Hex;
  message: {
    orderRecordId: Hex;
    refundId: Hex;
    providerAgentId: string;
    authorizationDigest: Hex;
    payer: Hex;
    token: Hex;
    grossAmount: string;
    refundWallet: Hex;
    refundPolicyVersion: Hex;
    refundReason: Hex;
    evidenceHash: Hex;
    instructionNonce: Hex;
    issuedAt: string;
    expiresAt: string;
  };
}

export interface BazaarRefundInstructionSigningBroker {
  address: Hex;
  signRefundInstruction(
    input: BazaarRefundInstructionSigningRequest,
    signal: AbortSignal,
  ): Promise<Hex>;
}

export interface BazaarRefundRequestService {
  requestRefund(input: {
    refundId: Hex;
    providerAgentId: bigint;
    refundWallet: Hex;
    refundPolicyVersion: Hex;
    instruction: {
      domain: Record<string, unknown>;
      types: Record<string, readonly { name: string; type: string }[]>;
      primaryType: "DaskiBazaarRefundInstruction";
      message: BazaarRefundInstructionSigningRequest["message"];
      signature: Hex;
    };
  }, signal: AbortSignal): Promise<
    | { kind: "broadcast"; refundId: Hex; transaction: Hex }
    | { kind: "blocked_issuer"; refundId: Hex; evidenceHash: Hex }
    | { kind: "deferred"; refundId: Hex }
  >;
}

export interface BazaarRefundEvidenceInput {
  transaction: Hex;
  chainId: bigint;
  token: Hex;
  refundWallet: Hex;
  payer: Hex;
  grossAmount: bigint;
}

export interface BazaarRefundEvidenceVerifier {
  verify(input: BazaarRefundEvidenceInput, signal: AbortSignal): Promise<
    BazaarRefundEvidenceInput & {
      finalized: true;
      matchingTransferEventCount: 1;
      evidenceHash: Hex;
      blockHash: Hex;
      transferLogIndex: number;
    }
  >;
}

export interface BazaarFinancialStatus {
  exposureState: "reserved" | "paid_unfulfilled" | "refund_due" | "released";
  refund: null | {
    refundId: Hex;
    state: "due" | "broadcast" | "finalized" | "blocked_issuer";
    payer: Hex;
    token: Hex;
    grossAmount: string;
    primaryReason: BazaarRefundReason;
    dueAt: string;
    transaction: Hex | null;
    issuerBlockEvidenceHash: Hex | null;
  };
}

export interface BazaarCompatibilityWiring {
  listings: BazaarListing[];
  recoveryListings: BazaarListing[];
  retiredLifecycleCommitments: Hex[];
  adapterCallTimeoutMs: number;
  publicOrigin: string;
  approvedTermsOrigins: string[];
  facilitator: BazaarFacilitatorClient;
  evidenceVerifier: SettlementEvidenceVerifier;
  settlementObserver: BazaarSettlementObserver;
  settlementObservationPolicy: BazaarSettlementObservationPolicy;
  fulfillmentObserver: BazaarFulfillmentObserver;
  fulfillmentObservationPolicy: BazaarFulfillmentObservationPolicy;
  payerProfileVerifier: BazaarPayerProfileVerifier;
  fulfillment: BazaarFulfillmentService;
  challengeMac: BazaarChallengeMacKeyring;
  settlementCapacity: BazaarSettlementCapacityPolicy;
  refundRiskPolicies: Record<string, BazaarRefundRiskPolicy>;
  refundWorkerPolicy: BazaarRefundWorkerPolicy;
  refundInstructionSigningBroker: BazaarRefundInstructionSigningBroker;
  refundRequestService: BazaarRefundRequestService;
  refundEvidenceVerifier: BazaarRefundEvidenceVerifier;
  providerActionSigningBroker: BazaarProviderActionSigningBroker;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export type BazaarOrderState =
  | "attempt_opened"
  | "verify_rejected"
  | "verify_ambiguous"
  | "settle_started"
  | "settle_rejected"
  | "settle_ambiguous"
  | "settle_confirmed"
  | "evidence_rejected"
  | "settled"
  | "dispatch_started"
  | "dispatch_ambiguous"
  | "dispatch_failed"
  | "dispatched"
  | "fulfilled"
  | "fulfillment_refund_due"
  | "rejected_expired_no_transfer"
  | "ambiguous_expired_no_transfer"
  | "invalid_evidence_expired_no_transfer"
  | "unapproved_direct_inbound"
  | "settlement_refund_due"
  | "refund_finalized"
  | "refund_blocked_issuer";

export type BazaarObservationOriginState = Extract<BazaarOrderState,
  "verify_rejected" | "verify_ambiguous" | "settle_rejected" |
  "settle_ambiguous" | "evidence_rejected">;

export interface BazaarOrder {
  orderRecordId: Hex;
  orderHandle: string;
  authorizationDigest: Hex;
  chainId: bigint;
  token: Hex;
  payer: Hex;
  nonce: Hex;
  providerAgentId: bigint;
  fulfillmentSigner: Hex;
  listingEpoch: Hex;
  listingCommitment: Hex;
  outcomeId: Hex;
  resource: string;
  requestHash: Hex;
  offerHash: Hex;
  grossAmount: bigint;
  payTo: Hex;
  authorizationValidBefore: bigint;
  state: BazaarOrderState;
  settlementTransaction: Hex | null;
  taskId: string | null;
  taskIdHash: Hex | null;
  failureCode: string | null;
}
