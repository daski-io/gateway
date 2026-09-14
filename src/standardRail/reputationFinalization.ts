import { parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Pool } from "../db/pool.js";
import type { ReputationOperationIntent } from "./reputationOperation.js";

const easEvents = parseAbi([
  "event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schema)",
]);

export interface FinalizableOperation {
  operation_id: string;
  order_id: string;
  canonical_intent: ReputationOperationIntent;
}

function attestationUid(receipt: TransactionReceipt, easAddress: Address): Hex {
  const logs = parseEventLogs({ abi: easEvents, logs: receipt.logs, strict: false });
  const events = logs.filter((log) => log.eventName === "Attested" &&
    log.address.toLowerCase() === easAddress.toLowerCase() && "uid" in log.args);
  if (events.length !== 1 || !("uid" in events[0]!.args)) {
    throw new Error("CONFIRMATION_UID_MISSING_OR_AMBIGUOUS");
  }
  return events[0]!.args.uid as Hex;
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
}): Promise<void> {
  const client = await args.pool.connect();
  try {
    await client.query("BEGIN");
    let result: Record<string, unknown> = {};
    const intent = args.operation.canonical_intent;
    if (intent.operation === "attest-confirmation") {
      const uid = attestationUid(args.receipt, args.easAddress);
      result = { attestationUid: uid, confirmation: intent.confirmation };
    } else if (intent.operation === "revoke-confirmation") {
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
      `UPDATE standard_confirmation_sponsorships SET state='charged',updated_at=now()
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
