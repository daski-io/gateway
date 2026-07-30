import type { Hex } from "../types.js";

export type ConfirmationSubmissionStatus =
  | "prepared"
  | "broadcast"
  | "confirmed"
  | "reverted"
  | "nonce_conflict";

export interface ConfirmationSubmissionRow {
  id: string;
  paymentId: bigint;
  attester: Hex;
  easAttesterNonce: bigint;
  confirmation: "Confirmed" | "NotConfirmed";
  refUid: Hex | null;
  requestHash: Hex;
  facilitatorTransactionId: string | null;
  attestationUid: Hex | null;
  status: ConfirmationSubmissionStatus;
  createdAt: Date;
}

export type ConfirmationSponsorshipLimit =
  | "payment"
  | "wallet"
  | "global";
