import { parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Pool } from "../db/pool.js";
import type { ReputationOperationIntent } from "./reputationOperation.js";

const easEvents = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
  "event Revoked(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
]);

export interface FinalizableOperation {
  operation_id: string;
  order_id: string;
  kind?: "register" | "confirmation" | "confirmation-v2";
  canonical_intent: ReputationOperationIntent;
}

export interface ReviewAttestationEvidence {
  uid: Hex; schema: Hex; time: bigint; expirationTime: bigint; revocationTime: bigint;
  refUID: Hex; recipient: Address; attester: Address; revocable: boolean; data: Hex;
}
export function reviewReceiptUid(receipt: TransactionReceipt, easAddress: Address, intent: ReputationOperationIntent): Hex {
  if (intent.operation === "register-order") throw new Error("NOT_A_REVIEW");
  const eventName = intent.operation === "attest-confirmation" ? "Attested" : "Revoked";
  const logs = parseEventLogs({ abi: easEvents, logs: receipt.logs, strict: true });
  const events = logs.filter(log => log.eventName === eventName && log.address.toLowerCase() === easAddress.toLowerCase());
  if (events.length !== 1) throw new Error("CONFIRMATION_UID_MISSING_OR_AMBIGUOUS");
  const event = events[0]!.args;
  const payer = intent.operation === "attest-confirmation" ? intent.request.attester : intent.request.revoker;
  if (event.schema.toLowerCase() !== intent.request.schema.toLowerCase() || event.attester.toLowerCase() !== payer.toLowerCase() ||
      (intent.operation === "attest-confirmation" && event.recipient.toLowerCase() !== intent.request.data.recipient.toLowerCase()) ||
      (intent.operation === "revoke-confirmation" && event.uid.toLowerCase() !== intent.request.data.uid.toLowerCase())) {
    throw new Error("CONFIRMATION_RECEIPT_INTENT_MISMATCH");
  }
  return event.uid;
}

function verifyAttestation(intent: ReputationOperationIntent, uid: Hex, evidence?: ReviewAttestationEvidence): void {
  if (intent.operation === "register-order") return;
  const payer = intent.operation === "attest-confirmation" ? intent.request.attester : intent.request.revoker;
  if (!evidence || evidence.uid.toLowerCase() !== uid.toLowerCase() || evidence.schema.toLowerCase() !== intent.request.schema.toLowerCase() ||
      evidence.attester.toLowerCase() !== payer.toLowerCase() || !evidence.revocable) throw new Error("CONFIRMATION_ATTESTATION_INTENT_MISMATCH");
  if (intent.operation === "attest-confirmation" && (
      evidence.recipient.toLowerCase() !== intent.request.data.recipient.toLowerCase() || evidence.expirationTime !== 0n ||
      evidence.refUID.toLowerCase() !== intent.request.data.refUID.toLowerCase() || evidence.data.toLowerCase() !== intent.request.data.data.toLowerCase())) {
    throw new Error("CONFIRMATION_ATTESTATION_INTENT_MISMATCH");
  }
  if (intent.operation === "revoke-confirmation" && evidence.revocationTime === 0n) throw new Error("CONFIRMATION_REVOCATION_UNPROVEN");
}

/**
 * Marks a sponsored operation final from its receipt. The order's stored
 * confirmation state is NOT derived from the receipt: it is written only from
 * a finalized, hash-pinned `getRecord` read (StandardConfirmationState), which
 * the worker performs right after this step.
 */
export async function finalizeReputationOperation(args: {
  pool: Pool;
  operation: FinalizableOperation;
  transactionId: string;
  easAddress: Address;
  receipt: TransactionReceipt;
  attestation?: ReviewAttestationEvidence;
}): Promise<void> {
  if (args.receipt.status !== "success") throw new Error("REPUTATION_RECEIPT_NOT_SUCCESSFUL");
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");
    let result: Record<string, unknown> = {};
    const intent = args.operation.canonical_intent;
    if (intent.operation === "attest-confirmation") {
      const uid = reviewReceiptUid(args.receipt, args.easAddress, intent);
      verifyAttestation(intent, uid, args.attestation);
      result = { attestationUid: uid, confirmation: intent.confirmation };
    } else if (intent.operation === "revoke-confirmation") {
      const uid = reviewReceiptUid(args.receipt, args.easAddress, intent);
      verifyAttestation(intent, uid, args.attestation);
      result = { revokedUid: intent.request.data.uid, confirmation: "Pending" };
    }
    await client.query(
      `UPDATE standard_reputation_transactions SET state='final',block_number=$2,block_hash=$3,
         final_at=now(),updated_at=now() WHERE transaction_id=$1`,
      [args.transactionId, args.receipt.blockNumber.toString(), args.receipt.blockHash],
    );
    await client.query(
      `UPDATE standard_reputation_operations SET state='final',result=$2,final_block_number=$3,
         final_block_hash=$4,next_attempt_at=NULL,updated_at=now() WHERE operation_id=$1`,
      [args.operation.operation_id, result, args.receipt.blockNumber.toString(), args.receipt.blockHash],
    );
    await client.query(
      `UPDATE ${args.operation.kind === "confirmation-v2" ? "standard_confirmation_sponsorships_v2" : "standard_confirmation_sponsorships"} SET state='charged',updated_at=now()
       WHERE operation_id=$1 AND state='reserved'`,
      [args.operation.operation_id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
