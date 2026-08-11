import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import { transitionBazaarExposure } from "./refundAccounting.js";

export async function recordBazaarRefundBroadcast(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  transaction: Hex;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const refund = await client.query(
      `UPDATE bazaar_refund_obligations
          SET state = 'broadcast', refund_transaction = $3,
              broadcast_at = now(), updated_at = now()
        WHERE order_record_id = $1 AND state = 'due'
          AND EXISTS (
            SELECT 1 FROM bazaar_refund_jobs
             WHERE order_record_id = $1 AND state = 'working'
               AND lease_token = $2 AND lease_expires_at > now()
          )`,
      [
        hexToBytea(input.orderRecordId), input.leaseToken,
        hexToBytea(input.transaction),
      ],
    );
    const job = await client.query(
      `UPDATE bazaar_refund_jobs
          SET state = 'pending', next_attempt_at = now(), lease_token = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'working'
          AND lease_token = $2 AND lease_expires_at > now()`,
      [hexToBytea(input.orderRecordId), input.leaseToken],
    );
    if (refund.rowCount !== 1 || job.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markBazaarRefundBlocked(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  evidenceHash: Hex;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const refund = await client.query(
      `UPDATE bazaar_refund_obligations
          SET state = 'blocked_issuer', issuer_block_evidence_hash = $3,
              issuer_blocked_at = now(), updated_at = now()
        WHERE order_record_id = $1 AND state = 'due'
          AND EXISTS (
            SELECT 1 FROM bazaar_refund_jobs
             WHERE order_record_id = $1 AND state = 'working'
               AND lease_token = $2 AND lease_expires_at > now()
          )`,
      [
        hexToBytea(input.orderRecordId), input.leaseToken,
        hexToBytea(input.evidenceHash),
      ],
    );
    const order = await client.query(
      `UPDATE bazaar_orders SET state = 'refund_blocked_issuer', updated_at = now()
        WHERE order_record_id = $1
          AND state IN (
            'dispatch_failed', 'settlement_refund_due', 'fulfillment_refund_due'
          )`,
      [hexToBytea(input.orderRecordId)],
    );
    const job = await client.query(
      `UPDATE bazaar_refund_jobs
          SET state = 'blocked', lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'working'
          AND lease_token = $2 AND lease_expires_at > now()`,
      [hexToBytea(input.orderRecordId), input.leaseToken],
    );
    if (refund.rowCount !== 1 || order.rowCount !== 1 || job.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeBazaarRefund(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  evidenceHash: Hex;
  blockHash: Hex;
  transferLogIndex: number;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const refund = await client.query(
      `UPDATE bazaar_refund_obligations
          SET state = 'finalized', finalization_evidence_hash = $3,
              finalization_block_hash = $4,
              finalization_transfer_log_index = $5,
              finalized_at = now(), updated_at = now()
        WHERE order_record_id = $1 AND state = 'broadcast'
          AND refund_transaction IS NOT NULL AND broadcast_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM bazaar_refund_jobs
             WHERE order_record_id = $1 AND state = 'working'
               AND lease_token = $2 AND lease_expires_at > now()
          )`,
      [
        hexToBytea(input.orderRecordId), input.leaseToken,
        hexToBytea(input.evidenceHash), hexToBytea(input.blockHash),
        input.transferLogIndex,
      ],
    );
    const order = await client.query(
      `UPDATE bazaar_orders SET state = 'refund_finalized', updated_at = now()
        WHERE order_record_id = $1
          AND state IN (
            'dispatch_failed', 'settlement_refund_due', 'fulfillment_refund_due'
          )`,
      [hexToBytea(input.orderRecordId)],
    );
    const job = await client.query(
      `UPDATE bazaar_refund_jobs
          SET state = 'complete', lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'working'
          AND lease_token = $2 AND lease_expires_at > now()`,
      [hexToBytea(input.orderRecordId), input.leaseToken],
    );
    if (refund.rowCount !== 1 || order.rowCount !== 1 || job.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await transitionBazaarExposure(
      client,
      input.orderRecordId,
      "refund_due",
      "released",
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
