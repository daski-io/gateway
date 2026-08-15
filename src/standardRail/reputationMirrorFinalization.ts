import {
  parseAbi,
  parseEventLogs,
  type Address,
  type TransactionReceipt,
} from "viem";
import type { Pool } from "../db/pool.js";

const mirrorEvents = parseAbi([
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
]);

export interface FinalizableMirrorRow {
  order_id: string;
  provider_agent_id: string;
  outcome_id: string;
}

export interface FinalizableMirrorTransaction {
  transaction_id: string;
  desired_revision: string;
  operation: "give" | "revoke";
  target_uid: Buffer | null;
  target_confirmation: "Confirmed" | "NotConfirmed" | null;
}

export async function finalizeReputationMirrorTransaction(args: {
  pool: Pool;
  registry: Address;
  clientAddress: Address;
  row: FinalizableMirrorRow;
  transaction: FinalizableMirrorTransaction;
  receipt: TransactionReceipt;
}): Promise<void> {
  const tx = args.transaction;
  let feedbackIndex: bigint | null = null;
  if (tx.operation === "give") {
    const uid = tx.target_uid ? `0x${tx.target_uid.toString("hex")}`.toLowerCase() : null;
    const expectedValue = tx.target_confirmation === "Confirmed" ? 100n : 0n;
    const events = parseEventLogs({ abi: mirrorEvents, logs: args.receipt.logs, strict: false })
      .filter((event) => event.eventName === "NewFeedback" &&
        event.address.toLowerCase() === args.registry.toLowerCase() &&
        "feedbackIndex" in event.args && uid !== null && event.args.clientAddress &&
        event.args.feedbackHash && event.args.agentId === BigInt(args.row.provider_agent_id) &&
        event.args.clientAddress.toLowerCase() === args.clientAddress.toLowerCase() &&
        event.args.feedbackHash.toLowerCase() === uid && event.args.value === expectedValue &&
        event.args.valueDecimals === 0 && event.args.tag1 === "daski" &&
        event.args.tag2 === args.row.outcome_id);
    if (events.length !== 1 || !("feedbackIndex" in events[0]!.args)) {
      throw new Error("MIRROR_FEEDBACK_EVENT_MISSING_OR_AMBIGUOUS");
    }
    feedbackIndex = events[0]!.args.feedbackIndex as bigint;
  }
  await args.pool.query(
    `WITH done AS (UPDATE standard_reputation_mirror_transactions SET state='final',block_number=$2,
       updated_at=now() WHERE transaction_id=$1 AND state IN ('prepared','broadcast','operator_attention')
       RETURNING transaction_id)
     UPDATE standard_reputation_mirrors SET active_feedback_index=$3,
       active_uid=CASE WHEN $4::text='give' THEN $5::bytea ELSE NULL END,
       state=CASE WHEN desired_revision=$6::bigint
         THEN CASE WHEN $4::text='give' OR desired_uid IS NULL THEN 'current' ELSE 'pending' END
         ELSE 'pending' END,
       attempts=0,next_attempt_at=CASE WHEN desired_revision=$6::bigint
         AND ($4::text='give' OR desired_uid IS NULL) THEN NULL ELSE now() END,
       updated_at=now() WHERE order_id=$7 AND EXISTS (SELECT 1 FROM done)`,
    [tx.transaction_id, args.receipt.blockNumber.toString(), feedbackIndex?.toString() ?? null,
      tx.operation, tx.target_uid, tx.desired_revision, args.row.order_id],
  );
}
