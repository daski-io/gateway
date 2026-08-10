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

export interface BazaarListing {
  routePath: string;
  resourceUrl: string;
  description: string;
  sellerName: string;
  expectedDelivery: string;
  refundTerms: string;
  termsUrl: string;
  requestSchema: Record<string, unknown>;
  responseSchema: Record<string, unknown>;
  assetName: string;
  assetVersion: string;
  listingEpoch: Hex;
  listingCommitment: Hex;
  termsHash: Hex;
  policyVersion: Hex;
  payToControlProof: PayToControlProofV1;
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
  ): Promise<FacilitatorCallResult<VerifyResponse>>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
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
  verify(input: SettlementEvidenceInput): Promise<SettlementEvidenceInput & {
    finalized: true;
    authorizationUsedEventCount: 1;
    matchingTransferEventCount: 1;
  }>;
}

export interface BazaarPayerProfileVerifier {
  verifyBeforeSettlement(input: {
    chainId: bigint;
    payer: Hex;
  }): Promise<{ profile: "eoa" } | { profile: "unsupported" }>;
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

export interface BazaarFulfillmentService {
  dispatch(input: BazaarDispatchInput): Promise<{ taskId: string }>;
  performLifecycleAction(
    input: BazaarLifecycleDispatchInput,
  ): Promise<Record<string, unknown>>;
}

export type BazaarLifecycleAction =
  | "ORDER_STATUS"
  | "ARTIFACT_GET"
  | "SUPPORT_MESSAGE";

export interface BazaarLifecycleDispatchInput {
  taskId: string | null;
  action: BazaarLifecycleAction;
  assertion: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: "DaskiBazaarLifecycleAction";
    message: Record<string, unknown>;
    signature: Hex;
  };
}

export interface BazaarLifecycleSigner {
  address: Hex;
  signTypedData(input: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export interface BazaarCompatibilityWiring {
  listings: BazaarListing[];
  facilitator: BazaarFacilitatorClient;
  evidenceVerifier: SettlementEvidenceVerifier;
  payerProfileVerifier: BazaarPayerProfileVerifier;
  fulfillment: BazaarFulfillmentService;
  challengeSigner: BazaarLifecycleSigner;
  providerActionSigner: BazaarLifecycleSigner;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

export type BazaarOrderState =
  | "claimed"
  | "verify_rejected"
  | "verify_ambiguous"
  | "settle_started"
  | "settle_rejected"
  | "settle_ambiguous"
  | "settle_confirmed"
  | "evidence_rejected"
  | "settled"
  | "dispatch_started"
  | "dispatch_failed"
  | "dispatched";

export interface BazaarOrder {
  orderRecordId: Hex;
  orderHandle: string;
  authorizationDigest: Hex;
  chainId: bigint;
  token: Hex;
  payer: Hex;
  nonce: Hex;
  providerAgentId: bigint;
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
