import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { BazaarRefundReason } from "./types.js";

const REFUND_LEASE_SECONDS = 120;

interface RawRefundWorkItem {
  order_record_id: Buffer;
  refund_id: Buffer;
  authorization_digest: Buffer;
  provider_agent_id: string;
  payer: Buffer;
  token: Buffer;
  gross_amount: string;
  primary_reason: BazaarRefundReason;
  evidence_hash: Buffer;
  refund_state: "due" | "broadcast";
  refund_transaction: Buffer | null;
  refund_wallet: Buffer;
  refund_policy_version: Buffer;
  chain_id: string;
  pay_to: Buffer;
  attempt_count: number;
  lease_token: string;
}

export interface BazaarRefundWorkItem {
  orderRecordId: Hex;
  refundId: Hex;
  authorizationDigest: Hex;
  providerAgentId: bigint;
  payer: Hex;
  token: Hex;
  grossAmount: bigint;
  primaryReason: BazaarRefundReason;
  evidenceHash: Hex;
  refundState: "due" | "broadcast";
  refundTransaction: Hex | null;
  refundWallet: Hex;
  refundPolicyVersion: Hex;
  chainId: bigint;
  payTo: Hex;
  attemptCount: number;
  leaseToken: string;
}

export async function claimBazaarRefund(input: {
  pool: Pool;
  leaseOwner: string;
}): Promise<BazaarRefundWorkItem | null> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ order_record_id: Buffer }>(
      `SELECT j.order_record_id
         FROM bazaar_refund_jobs j
         JOIN bazaar_refund_obligations r USING (order_record_id)
         JOIN bazaar_orders o USING (order_record_id)
        WHERE (
          (j.state = 'pending' AND j.next_attempt_at <= now())
          OR (j.state = 'working' AND j.lease_expires_at <= now())
        )
          AND r.state IN ('due', 'broadcast')
          AND r.evidence_hash IS NOT NULL
          AND o.state IN (
            'dispatch_failed', 'settlement_refund_due', 'fulfillment_refund_due'
          )
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
      `UPDATE bazaar_refund_jobs
          SET state = 'working', attempt_count = attempt_count + 1,
              lease_token = $2, lease_owner = $3,
              lease_expires_at = now() + make_interval(secs => $4),
              updated_at = now()
        WHERE order_record_id = $1`,
      [row.order_record_id, leaseToken, input.leaseOwner, REFUND_LEASE_SECONDS],
    );
    const work = await client.query<RawRefundWorkItem>(
      `SELECT r.order_record_id, r.refund_id, r.authorization_digest,
              r.provider_agent_id, r.payer, r.token, r.gross_amount,
              r.primary_reason, r.evidence_hash, r.state AS refund_state,
              r.refund_transaction, r.refund_wallet,
              r.refund_policy_version, o.chain_id, o.pay_to,
              j.attempt_count, j.lease_token
         FROM bazaar_refund_obligations r
         JOIN bazaar_refund_jobs j USING (order_record_id)
         JOIN bazaar_orders o USING (order_record_id)
        WHERE r.order_record_id = $1`,
      [row.order_record_id],
    );
    const workRow = work.rows[0];
    if (!workRow) throw new Error("Bazaar refund claim disappeared");
    await client.query("COMMIT");
    return toWorkItem(workRow);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function renewBazaarRefundLease(
  pool: Pool,
  orderRecordId: Hex,
  leaseToken: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE bazaar_refund_jobs
        SET lease_expires_at = now() + make_interval(secs => $3),
            updated_at = now()
      WHERE order_record_id = $1 AND state = 'working'
        AND lease_token = $2 AND lease_expires_at > now()`,
    [hexToBytea(orderRecordId), leaseToken, REFUND_LEASE_SECONDS],
  );
  return result.rowCount === 1;
}

export async function deferBazaarRefund(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  retryDelaySeconds: number;
}): Promise<boolean> {
  const result = await input.pool.query(
    `UPDATE bazaar_refund_jobs
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

function toWorkItem(row: RawRefundWorkItem): BazaarRefundWorkItem {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id),
    refundId: hex(row.refund_id),
    authorizationDigest: hex(row.authorization_digest),
    providerAgentId: BigInt(row.provider_agent_id),
    payer: hex(row.payer),
    token: hex(row.token),
    grossAmount: BigInt(row.gross_amount),
    primaryReason: row.primary_reason,
    evidenceHash: hex(row.evidence_hash),
    refundState: row.refund_state,
    refundTransaction: row.refund_transaction ? hex(row.refund_transaction) : null,
    refundWallet: hex(row.refund_wallet),
    refundPolicyVersion: hex(row.refund_policy_version),
    chainId: BigInt(row.chain_id),
    payTo: hex(row.pay_to),
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
  };
}
