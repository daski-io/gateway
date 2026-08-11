import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";

const FULFILLMENT_LEASE_SECONDS = 120;

interface RawFulfillmentWorkItem {
  order_record_id: Buffer;
  task_id: string;
  task_id_hash: Buffer;
  provider_agent_id: string;
  fulfillment_signer: Buffer;
  listing_commitment: Buffer;
  authorization_digest: Buffer;
  outcome_id: Buffer;
  request_hash: Buffer;
  settlement_transaction: Buffer;
  chain_id: string;
  pay_to: Buffer;
  attempt_count: number;
  lease_token: string;
}

export interface BazaarFulfillmentWorkItem {
  orderRecordId: Hex;
  taskId: string;
  taskIdHash: Hex;
  providerAgentId: bigint;
  fulfillmentSigner: Hex;
  listingCommitment: Hex;
  authorizationDigest: Hex;
  outcomeId: Hex;
  requestHash: Hex;
  settlementTransaction: Hex;
  chainId: bigint;
  payTo: Hex;
  attemptCount: number;
  leaseToken: string;
}

export async function claimBazaarFulfillment(input: {
  pool: Pool;
  leaseOwner: string;
}): Promise<BazaarFulfillmentWorkItem | null> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ order_record_id: Buffer }>(
      `SELECT j.order_record_id
         FROM bazaar_fulfillment_jobs j
         JOIN bazaar_orders o USING (order_record_id)
        WHERE (
          (j.state = 'pending' AND j.next_attempt_at <= now())
          OR (j.state = 'working' AND j.lease_expires_at <= now())
        ) AND o.state = 'dispatched'
        ORDER BY j.next_attempt_at, j.updated_at
        LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
    );
    const row = due.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    const leaseToken = randomUUID();
    await client.query(
      `UPDATE bazaar_fulfillment_jobs
          SET state = 'working', attempt_count = attempt_count + 1,
              lease_token = $2, lease_owner = $3,
              lease_expires_at = now() + make_interval(secs => $4),
              updated_at = now()
        WHERE order_record_id = $1`,
      [row.order_record_id, leaseToken, input.leaseOwner, FULFILLMENT_LEASE_SECONDS],
    );
    const work = await client.query<RawFulfillmentWorkItem>(
      `SELECT o.order_record_id, o.task_id, o.task_id_hash,
              o.provider_agent_id, o.fulfillment_signer,
              o.listing_commitment, o.authorization_digest, o.outcome_id,
              o.request_hash, o.settlement_transaction, o.chain_id, o.pay_to,
              j.attempt_count, j.lease_token
         FROM bazaar_orders o
         JOIN bazaar_fulfillment_jobs j USING (order_record_id)
        WHERE o.order_record_id = $1 AND o.task_id IS NOT NULL
          AND o.task_id_hash IS NOT NULL AND o.settlement_transaction IS NOT NULL`,
      [row.order_record_id],
    );
    const workRow = work.rows[0];
    if (!workRow) throw new Error("Bazaar fulfillment claim disappeared");
    await client.query("COMMIT");
    return toWorkItem(workRow);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function renewBazaarFulfillmentLease(
  pool: Pool,
  orderRecordId: Hex,
  leaseToken: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE bazaar_fulfillment_jobs
        SET lease_expires_at = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE order_record_id = $1 AND state = 'working'
        AND lease_token = $2 AND lease_expires_at > now()`,
    [hexToBytea(orderRecordId), leaseToken, FULFILLMENT_LEASE_SECONDS],
  );
  return result.rowCount === 1;
}

export async function deferBazaarFulfillment(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  retryDelaySeconds: number;
}): Promise<boolean> {
  const result = await input.pool.query(
    `UPDATE bazaar_fulfillment_jobs
        SET state = 'pending', next_attempt_at =
              now() + make_interval(secs => $3),
            lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = now()
      WHERE order_record_id = $1 AND state = 'working'
        AND lease_token = $2 AND lease_expires_at > now()`,
    [hexToBytea(input.orderRecordId), input.leaseToken, input.retryDelaySeconds],
  );
  return result.rowCount === 1;
}

function toWorkItem(row: RawFulfillmentWorkItem): BazaarFulfillmentWorkItem {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id), taskId: row.task_id,
    taskIdHash: hex(row.task_id_hash), providerAgentId: BigInt(row.provider_agent_id),
    fulfillmentSigner: hex(row.fulfillment_signer),
    listingCommitment: hex(row.listing_commitment),
    authorizationDigest: hex(row.authorization_digest), outcomeId: hex(row.outcome_id),
    requestHash: hex(row.request_hash),
    settlementTransaction: hex(row.settlement_transaction), chainId: BigInt(row.chain_id),
    payTo: hex(row.pay_to), attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
  };
}
