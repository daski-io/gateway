import type { Hex } from "../types.js";

export type SettlementState =
  | "pending"
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
  amount: bigint;
  providerA2AUrl: string;
  walletAddress: Hex;
  createdAt: Date;
  expiresAt: Date;
  settlementState: SettlementState;
  paymentId: bigint | null;
  transactionHash: Hex | null;
  verifiedAt: Date | null;
  confirmationAttestationUid: Hex | null;
  quoteId: string | null;
  quoteSignature: Hex | null;
  quoteRequestHash: Hex | null;
  quoteExpiresAt: Date | null;
}
