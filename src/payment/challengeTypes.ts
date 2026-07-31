import type {
  DaskiX402Declaration,
  Hex,
  PaymentRequired,
  SettlementResponse,
} from "../types.js";

export type SettlementState =
  | "pending"
  | "settlement_prepared"
  | "settlement_broadcast"
  | "paid"
  | "expired"
  | "sanctions_rejected";

/** Internal representation of one persisted payment challenge. */
export interface StoredChallenge {
  serviceRef: Hex;
  providerTokenId: bigint;
  buyerTokenId: bigint;
  skillId: string | null;
  serviceSlug: string;
  serviceVersion: string;
  serviceId: Hex;
  expectedPayee: Hex | null;
  expectedPayeeBlock: bigint | null;
  amount: bigint;
  providerA2AUrl: string;
  walletAddress: Hex;
  createdAt: Date;
  expiresAt: Date;
  settlementState: SettlementState;
  paymentId: bigint | null;
  transactionHash: Hex | null;
  settlementFacilitatorTransactionId: string | null;
  providerAuthorityWallet: Hex | null;
  providerAuthorityAgentUri: string | null;
  providerAuthorityBlock: bigint | null;
  verifiedAt: Date | null;
  confirmationAttestationUid: Hex | null;
  quoteId: string | null;
  quoteSignature: Hex | null;
  quoteRequestHash: Hex | null;
  quoteExpiresAt: Date | null;
  x402Version: number | null;
  paymentRequired: PaymentRequired | null;
  requirementsHash: Hex | null;
  resourceUrl: string | null;
  daskiExtension: DaskiX402Declaration | null;
  requestFingerprint: Hex | null;
  registrationDelegation: {
    agentURI: string;
    deadline: string;
    signature: Hex;
  } | null;
  acceptedPayer: Hex | null;
  eip3009Nonce: Hex | null;
  paymentPayloadFingerprint: Hex | null;
  settleResponse: SettlementResponse | null;
}
