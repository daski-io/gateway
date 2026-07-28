import type {
  DaskiX402Declaration,
  Hex,
  PaymentRequired,
  SettlementResponse,
} from "../types.js";

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
  /**
   * Canonical serviceArgs the quote committed to (migration 017). The
   * settle retry and task submit restore these when the caller omits
   * serviceArgs — the request hash still verifies against
   * quoteRequestHash, so what was signed is what executes. Null on rows
   * that predate the migration.
   */
  serviceArgs: Record<string, unknown> | null;
  /** Flow context captured at quote time. Only `buyerName` is written
   *  since the de-scar (260726) removed the acknowledgement gates; the
   *  Record shape is kept for rows written by earlier releases. */
  acknowledgements: Record<string, unknown>;
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
