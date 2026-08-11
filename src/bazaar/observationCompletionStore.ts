import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import {
  createBazaarRefundDue,
  transitionBazaarExposure,
  type BazaarRefundBinding,
} from "./refundAccounting.js";
import type {
  BazaarObservationOriginState,
  BazaarOrderState,
  BazaarRefundReason,
  BazaarSettlementObservationResult,
} from "./types.js";

type NoTransferResult = Extract<
  BazaarSettlementObservationResult,
  { kind: "no_transfer" }
>;
type MatchingTransferResult = Extract<
  BazaarSettlementObservationResult,
  { kind: "matching_transfer" }
>;
type NoTransferState = Extract<BazaarOrderState,
  "rejected_expired_no_transfer" | "ambiguous_expired_no_transfer" |
  "invalid_evidence_expired_no_transfer">;

interface RawRefundOrder {
  order_record_id: Buffer;
  authorization_digest: Buffer;
  provider_agent_id: string;
  payer: Buffer;
  token: Buffer;
  gross_amount: string;
}

export async function completeBazaarNoTransfer(input: {
  pool: Pool;
  orderRecordId: Hex;
  originState: BazaarObservationOriginState;
  terminalState: NoTransferState;
  leaseToken: string;
  observation: NoTransferResult;
}): Promise<boolean> {
  if (!validNoTransferTarget(input.originState, input.terminalState)) {
    throw new Error("Bazaar no-transfer classification is invalid");
  }
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const observation = await client.query(
      `UPDATE bazaar_settlement_observations
          SET state = 'no_transfer', observed_through = $4,
              evidence_hash = $5, lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND origin_state = $2
          AND state = 'observing' AND lease_token = $3
          AND lease_expires_at > now()`,
      [
        hexToBytea(input.orderRecordId), input.originState, input.leaseToken,
        input.observation.observedThrough.toString(),
        hexToBytea(input.observation.evidenceHash),
      ],
    );
    const order = await client.query(
      `UPDATE bazaar_orders SET state = $3, updated_at = now()
        WHERE order_record_id = $1 AND state = $2`,
      [hexToBytea(input.orderRecordId), input.originState, input.terminalState],
    );
    if (observation.rowCount !== 1 || order.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await transitionBazaarExposure(client, input.orderRecordId, "reserved", "released");
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeBazaarObservedTransfer(input: {
  pool: Pool;
  orderRecordId: Hex;
  originState: BazaarObservationOriginState;
  leaseToken: string;
  observation: MatchingTransferResult;
} & (
  | { disposition: "unapproved" }
  | {
      disposition: "refund_due";
      reason: Extract<BazaarRefundReason,
        "AMBIGUOUS_PAID" | "SETTLEMENT_EVIDENCE_INVALID">;
    }
)): Promise<boolean> {
  assertTransferDisposition(input.originState, input.disposition);
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const observation = await client.query(
      `UPDATE bazaar_settlement_observations
          SET state = $4, observed_through = $5, evidence_hash = $6,
              observed_transaction = $7, observed_block_hash = $8,
              transaction_index = $9, authorization_log_index = $10,
              transfer_log_index = $11, lease_token = NULL,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND origin_state = $2
          AND state = 'observing' AND lease_token = $3
          AND lease_expires_at > now()`,
      [
        hexToBytea(input.orderRecordId), input.originState, input.leaseToken,
        input.disposition === "refund_due" ? "refund_due" : "unapproved_transfer",
        input.observation.observedThrough.toString(),
        hexToBytea(input.observation.evidenceHash),
        hexToBytea(input.observation.transaction),
        hexToBytea(input.observation.blockHash),
        input.observation.transactionIndex,
        input.observation.authorizationLogIndex,
        input.observation.transferLogIndex,
      ],
    );
    const order = await client.query<RawRefundOrder>(
      `UPDATE bazaar_orders SET state = $3, updated_at = now()
        WHERE order_record_id = $1 AND state = $2
        RETURNING order_record_id, authorization_digest, provider_agent_id,
                  payer, token, gross_amount`,
      [
        hexToBytea(input.orderRecordId), input.originState,
        input.disposition === "refund_due"
          ? "settlement_refund_due"
          : "unapproved_direct_inbound",
      ],
    );
    const orderRow = order.rows[0];
    if (observation.rowCount !== 1 || !orderRow) {
      await client.query("ROLLBACK");
      return false;
    }
    if (input.disposition === "refund_due") {
      await createBazaarRefundDue({
        client,
        order: toRefundBinding(orderRow),
        reason: input.reason,
        evidenceHash: input.observation.evidenceHash,
        expectedExposure: "reserved",
      });
    } else {
      await transitionBazaarExposure(
        client,
        input.orderRecordId,
        "reserved",
        "paid_unfulfilled",
      );
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

function validNoTransferTarget(
  origin: BazaarObservationOriginState,
  terminal: NoTransferState,
): boolean {
  if (origin === "evidence_rejected") {
    return terminal === "invalid_evidence_expired_no_transfer";
  }
  if (origin === "verify_ambiguous" || origin === "settle_ambiguous") {
    return terminal === "ambiguous_expired_no_transfer";
  }
  return terminal === "rejected_expired_no_transfer";
}

function assertTransferDisposition(
  origin: BazaarObservationOriginState,
  disposition: "unapproved" | "refund_due",
): void {
  const requiresRefund = origin === "settle_ambiguous" || origin === "evidence_rejected";
  if (requiresRefund !== (disposition === "refund_due")) {
    throw new Error("Bazaar observed-transfer disposition is invalid");
  }
}

function toRefundBinding(row: RawRefundOrder): BazaarRefundBinding {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id),
    authorizationDigest: hex(row.authorization_digest),
    providerAgentId: BigInt(row.provider_agent_id),
    payer: hex(row.payer),
    token: hex(row.token),
    grossAmount: BigInt(row.gross_amount),
  };
}
