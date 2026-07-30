import type { Hex } from "../types.js";

export type FacilitatorOperationKind =
  | "settlement"
  | "buyer_confirmation"
  | "feedback_revoke"
  | "feedback_give";

export type FacilitatorTransactionStatus =
  | "prepared"
  | "broadcast"
  | "succeeded"
  | "reverted"
  | "nonce_conflict";

export interface FacilitatorOperationOwner {
  kind: FacilitatorOperationKind;
  key: string;
}

export interface FacilitatorTransactionRow {
  id: string;
  operationKind: FacilitatorOperationKind;
  operationKey: string;
  attemptNumber: number;
  intentHash: Hex;
  status: FacilitatorTransactionStatus;
  preparedTransaction: Hex | null;
  transactionHash: Hex;
  transactionNonce: bigint;
  operationData: Record<string, unknown>;
  preparedAt: Date;
  broadcastAt: Date | null;
  resolvedAt: Date | null;
  submissionAttempts: number;
  receiptChecks: number;
  nextAttemptAt: Date;
  failureCode: string | null;
}
