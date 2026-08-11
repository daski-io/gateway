import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import {
  createBazaarRefundDue,
  computeBazaarRefundEvidenceHash,
  transitionBazaarExposure,
  type BazaarRefundBinding,
} from "./refundAccounting.js";
import type {
  BazaarFinancialStatus, BazaarRefundReason,
} from "./types.js";

interface RawRefundOrder {
  order_record_id: Buffer;
  authorization_digest: Buffer;
  provider_agent_id: string;
  payer: Buffer;
  token: Buffer;
  gross_amount: string;
}

interface RawFinancialStatus {
  exposure_state: BazaarFinancialStatus["exposureState"];
  refund_id: Buffer | null;
  refund_state: NonNullable<BazaarFinancialStatus["refund"]>["state"] | null;
  refund_payer: Buffer | null;
  refund_token: Buffer | null;
  refund_gross_amount: string | null;
  primary_reason: BazaarRefundReason | null;
  due_at: Date | null;
  refund_transaction: Buffer | null;
}

export async function markBazaarSettled(
  pool: Pool,
  orderRecordId: Hex,
  leaseToken: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE bazaar_orders SET state = 'settled', updated_at = now()
        WHERE order_record_id = $1 AND state = 'settle_confirmed'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [hexToBytea(orderRecordId), leaseToken],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await transitionBazaarExposure(client, orderRecordId, "reserved", "paid_unfulfilled");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markBazaarDispatched(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  taskId: string;
  taskIdHash: Hex;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE bazaar_orders
          SET state = 'dispatched', task_id = $3, task_id_hash = $4,
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'dispatch_started'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [
        hexToBytea(input.orderRecordId), input.leaseToken, input.taskId,
        hexToBytea(input.taskIdHash),
      ],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await transitionBazaarExposure(
      client, input.orderRecordId, "paid_unfulfilled", "paid_unfulfilled",
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

export async function markBazaarDispatchAmbiguous(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  failureCode: string;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE bazaar_orders
          SET state = 'dispatch_ambiguous', failure_code = $3,
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'dispatch_started'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [hexToBytea(input.orderRecordId), input.leaseToken, input.failureCode],
    );
    if (result.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await transitionBazaarExposure(
      client, input.orderRecordId, "paid_unfulfilled", "paid_unfulfilled",
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

export async function markBazaarDispatchRefundDue(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  expected: "settled" | "dispatch_started";
  reason: Extract<BazaarRefundReason,
    "PROVIDER_COMPLIANCE_FAILURE" | "PROVIDER_FULFILLMENT_FAILURE">;
  failureCode: string;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<RawRefundOrder>(
      `UPDATE bazaar_orders
          SET state = 'dispatch_failed', failure_code = $3,
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = $2
          AND processing_lease_token = $4
          AND processing_lease_expires_at > now()
        RETURNING order_record_id, authorization_digest, provider_agent_id,
                  payer, token, gross_amount`,
      [
        hexToBytea(input.orderRecordId), input.expected,
        input.failureCode, input.leaseToken,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    const binding = toRefundBinding(row);
    await createBazaarRefundDue({
      client,
      order: binding,
      reason: input.reason,
      evidenceHash: computeBazaarRefundEvidenceHash(
        binding,
        input.reason,
        input.failureCode,
      ),
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getBazaarFinancialStatus(
  pool: Pool,
  orderRecordId: Hex,
): Promise<BazaarFinancialStatus | null> {
  const result = await pool.query<RawFinancialStatus>(
    `SELECT e.state AS exposure_state, r.refund_id,
            r.state AS refund_state, r.payer AS refund_payer,
            r.token AS refund_token, r.gross_amount AS refund_gross_amount,
            r.primary_reason, r.due_at, r.refund_transaction
       FROM bazaar_exposures e
       LEFT JOIN bazaar_refund_obligations r USING (order_record_id)
      WHERE e.order_record_id = $1`,
    [hexToBytea(orderRecordId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  const refundFields = [
    row.refund_id, row.refund_state, row.refund_payer, row.refund_token,
    row.refund_gross_amount, row.primary_reason, row.due_at,
  ];
  if (refundFields.every((value) => value === null)) {
    return { exposureState: row.exposure_state, refund: null };
  }
  if (refundFields.some((value) => value === null)) {
    throw new Error("Bazaar refund status is partially bound");
  }
  return {
    exposureState: row.exposure_state,
    refund: {
      refundId: toHex(row.refund_id!),
      state: row.refund_state!,
      payer: toHex(row.refund_payer!),
      token: toHex(row.refund_token!),
      grossAmount: row.refund_gross_amount!,
      primaryReason: row.primary_reason!,
      dueAt: row.due_at!.toISOString(),
      transaction: row.refund_transaction ? toHex(row.refund_transaction) : null,
    },
  };
}

function toRefundBinding(row: RawRefundOrder): BazaarRefundBinding {
  return {
    orderRecordId: toHex(row.order_record_id),
    authorizationDigest: toHex(row.authorization_digest),
    providerAgentId: BigInt(row.provider_agent_id),
    payer: toHex(row.payer),
    token: toHex(row.token),
    grossAmount: BigInt(row.gross_amount),
  };
}

function toHex(value: Buffer): Hex {
  return `0x${value.toString("hex")}` as Hex;
}
