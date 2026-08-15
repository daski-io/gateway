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
      const uidBytes = Buffer.from(uid.slice(2), "hex");
      const applied = await client.query(
        `INSERT INTO standard_reputation_confirmations
          (order_id,order_key,current_uid,confirmation,transitions_used,finalized_block,finalized_block_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (order_id) DO UPDATE SET current_uid=EXCLUDED.current_uid,
           confirmation=EXCLUDED.confirmation,transitions_used=EXCLUDED.transitions_used,
           finalized_block=EXCLUDED.finalized_block,finalized_block_hash=EXCLUDED.finalized_block_hash,
           updated_at=now()
         WHERE standard_reputation_confirmations.transitions_used < EXCLUDED.transitions_used
            OR (standard_reputation_confirmations.transitions_used = EXCLUDED.transitions_used
              AND standard_reputation_confirmations.current_uid = EXCLUDED.current_uid
              AND standard_reputation_confirmations.confirmation = EXCLUDED.confirmation)
         RETURNING order_id`,
        [args.operation.order_id, Buffer.from(intent.orderKey.slice(2), "hex"), uidBytes,
          intent.confirmation, intent.transitionsUsed + 1, args.receipt.blockNumber.toString(),
          args.receipt.blockHash],
      );
      if (applied.rowCount === 1) {
        await client.query(
          `INSERT INTO standard_reputation_mirrors
            (order_id,desired_revision,desired_confirmation,desired_uid,state,next_attempt_at)
           VALUES ($1,$2,$3,$4,'pending',now())
           ON CONFLICT (order_id) DO UPDATE SET desired_revision=EXCLUDED.desired_revision,
             desired_confirmation=EXCLUDED.desired_confirmation,desired_uid=EXCLUDED.desired_uid,
             state=CASE WHEN standard_reputation_mirrors.state='broadcast' THEN 'broadcast' ELSE 'pending' END,
             next_attempt_at=CASE WHEN standard_reputation_mirrors.state='broadcast'
               THEN standard_reputation_mirrors.next_attempt_at ELSE now() END,updated_at=now()`,
          [args.operation.order_id, intent.transitionsUsed + 1, intent.confirmation, uidBytes],
        );
      }
      result = { attestationUid: uid, confirmation: intent.confirmation };
    } else if (intent.operation === "revoke-confirmation") {
      const applied = await client.query(
        `UPDATE standard_reputation_confirmations SET current_uid=NULL,confirmation='Pending',
           transitions_used=$2,finalized_block=$3,finalized_block_hash=$4,updated_at=now()
         WHERE order_id=$1 AND current_uid=$5 AND transitions_used=$2-1
         RETURNING order_id`,
        [args.operation.order_id, intent.transitionsUsed + 1, args.receipt.blockNumber.toString(),
          args.receipt.blockHash, Buffer.from(intent.request.data.uid.slice(2), "hex")],
      );
      if (applied.rowCount === 1) {
        await client.query(
          `INSERT INTO standard_reputation_mirrors
            (order_id,desired_revision,desired_confirmation,desired_uid,state,next_attempt_at)
           VALUES ($1,$2,NULL,NULL,'pending',now())
           ON CONFLICT (order_id) DO UPDATE SET desired_revision=EXCLUDED.desired_revision,
             desired_confirmation=NULL,desired_uid=NULL,
             state=CASE WHEN standard_reputation_mirrors.state='broadcast' THEN 'broadcast' ELSE 'pending' END,
             next_attempt_at=CASE WHEN standard_reputation_mirrors.state='broadcast'
               THEN standard_reputation_mirrors.next_attempt_at ELSE now() END,updated_at=now()`,
          [args.operation.order_id, intent.transitionsUsed + 1],
        );
      }
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
