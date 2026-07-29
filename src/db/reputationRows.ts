import type { Hex } from "../types.js";

export const REPUTATION_MIRROR_MAX_ATTEMPTS = 8;

export type ReputationMirrorStatus =
  | "queued"
  | "processing"
  | "prepared"
  | "broadcast"
  | "retry"
  | "sent"
  | "failed"
  | "skipped";

export interface ReputationMirrorDbRow {
  payment_id: string;
  attestation_uid: Buffer;
  provider_agent_id: string | null;
  feedback_index: string | null;
  tx_hash: Buffer | null;
  status: ReputationMirrorStatus;
  confirmation: "Confirmed" | "NotConfirmed" | null;
  ref_uid: Buffer | null;
  prepared_tx: Buffer | null;
  tx_nonce: string | null;
  prepared_at: Date | null;
  broadcast_at: Date | null;
  attempts: number;
  receipt_checks: number;
  next_attempt_at: Date;
  last_error: string | null;
  pending_attestation_uid: Buffer | null;
  pending_confirmation: "Confirmed" | "NotConfirmed" | null;
  pending_ref_uid: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReputationMirrorRow {
  paymentId: bigint;
  attestationUid: Hex;
  providerAgentId: bigint | null;
  feedbackIndex: bigint | null;
  txHash: Hex | null;
  status: ReputationMirrorStatus;
  confirmation: "Confirmed" | "NotConfirmed" | null;
  refUid: Hex | null;
  preparedTransaction: Hex | null;
  transactionNonce: bigint | null;
  preparedAt: Date | null;
  broadcastAt: Date | null;
  attempts: number;
  receiptChecks: number;
  nextAttemptAt: Date;
  lastError: string | null;
  pendingAttestationUid: Hex | null;
  pendingConfirmation: "Confirmed" | "NotConfirmed" | null;
  pendingRefUid: Hex | null;
  createdAt: Date;
  updatedAt: Date;
}

export const reputationBytea = (value: Hex): Buffer =>
  Buffer.from(value.slice(2), "hex");

const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

export function mapReputationMirrorRow(
  row: ReputationMirrorDbRow,
): ReputationMirrorRow {
  return {
    paymentId: BigInt(row.payment_id),
    attestationUid: hex(row.attestation_uid),
    providerAgentId:
      row.provider_agent_id == null ? null : BigInt(row.provider_agent_id),
    feedbackIndex:
      row.feedback_index == null ? null : BigInt(row.feedback_index),
    txHash: row.tx_hash ? hex(row.tx_hash) : null,
    status: row.status,
    confirmation: row.confirmation,
    refUid: row.ref_uid ? hex(row.ref_uid) : null,
    preparedTransaction: row.prepared_tx ? hex(row.prepared_tx) : null,
    transactionNonce: row.tx_nonce == null ? null : BigInt(row.tx_nonce),
    preparedAt: row.prepared_at,
    broadcastAt: row.broadcast_at,
    attempts: row.attempts,
    receiptChecks: row.receipt_checks,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    pendingAttestationUid: row.pending_attestation_uid
      ? hex(row.pending_attestation_uid)
      : null,
    pendingConfirmation: row.pending_confirmation,
    pendingRefUid: row.pending_ref_uid ? hex(row.pending_ref_uid) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
