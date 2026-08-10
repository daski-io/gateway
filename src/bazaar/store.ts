import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type {
  BazaarLifecycleAction,
  BazaarOrder,
  BazaarOrderState,
} from "./types.js";
import type { BazaarIndexingStatus } from "./extensionResponse.js";

interface RawOrder {
  order_record_id: Buffer;
  order_handle: string;
  authorization_digest: Buffer;
  chain_id: string;
  token: Buffer;
  payer: Buffer;
  nonce: Buffer;
  provider_agent_id: string;
  listing_epoch: Buffer;
  listing_commitment: Buffer;
  outcome_id: Buffer;
  resource: string;
  request_hash: Buffer;
  offer_hash: Buffer;
  gross_amount: string;
  pay_to: Buffer;
  authorization_valid_before: string;
  state: BazaarOrderState;
  settlement_transaction: Buffer | null;
  task_id: string | null;
  task_id_hash: Buffer | null;
  failure_code: string | null;
}

interface RawLeasedOrder extends RawOrder {
  processing_lease_token: string;
}

export interface ClaimOrderInput extends Omit<
  BazaarOrder,
  "state" | "settlementTransaction" | "taskId" | "taskIdHash" | "failureCode"
> {
  signatureDigest: Hex;
}

export interface LeasedBazaarOrder {
  order: BazaarOrder;
  leaseToken: string;
}

export const BAZAAR_LEASE_SECONDS = 120;

const SELECT_COLUMNS = `
  order_record_id, order_handle, authorization_digest, chain_id, token, payer,
  nonce, provider_agent_id, listing_epoch, listing_commitment, outcome_id,
  resource, request_hash, offer_hash, gross_amount, pay_to,
  authorization_valid_before, state, settlement_transaction, task_id,
  task_id_hash, failure_code
`;

export class BazaarOrderStore {
  constructor(private readonly pool: Pool) {}

  async hasBlockingIncident(listingCommitment: Hex): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM bazaar_orders
        WHERE listing_commitment = $1 AND state IN (
          'verify_ambiguous', 'settle_ambiguous', 'evidence_rejected',
          'dispatch_failed'
        ) LIMIT 1`,
      [hexToBytea(listingCommitment)],
    );
    return result.rowCount === 1;
  }

  async claim(
    input: ClaimOrderInput,
    leaseOwner: string,
  ): Promise<{ created: boolean; order: BazaarOrder; leaseToken: string | null }> {
    const leaseToken = randomUUID();
    const values = orderValues(input);
    const inserted = await this.pool.query<RawOrder>(
      `INSERT INTO bazaar_orders (
         order_record_id, order_handle, authorization_digest,
         authorization_signature_digest, chain_id, token, payer, nonce,
         provider_agent_id, listing_epoch, listing_commitment, outcome_id,
         resource, request_hash, offer_hash, gross_amount, pay_to,
         authorization_valid_before, state, processing_lease_token,
         processing_lease_owner, processing_lease_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, 'claimed', $19, $20,
         now() + make_interval(secs => $21)
       ) ON CONFLICT DO NOTHING RETURNING ${SELECT_COLUMNS}`,
      [...values, leaseToken, leaseOwner, BAZAAR_LEASE_SECONDS],
    );
    if (inserted.rows[0]) {
      return { created: true, order: toOrder(inserted.rows[0]), leaseToken };
    }
    const existing = await this.pool.query<RawOrder>(
      `SELECT ${SELECT_COLUMNS} FROM bazaar_orders
        WHERE authorization_digest = $1
           OR (chain_id = $2 AND token = $3 AND payer = $4 AND nonce = $5)`,
      [
        hexToBytea(input.authorizationDigest), input.chainId.toString(),
        hexToBytea(input.token), hexToBytea(input.payer), hexToBytea(input.nonce),
      ],
    );
    if (existing.rows.length !== 1) {
      throw new Error("Bazaar authorization uniqueness invariant violated");
    }
    return { created: false, order: toOrder(existing.rows[0]!), leaseToken: null };
  }

  async renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET processing_lease_expires_at =
                now() + make_interval(secs => $3), updated_at = now()
        WHERE order_record_id = $1 AND processing_lease_token = $2
          AND processing_lease_expires_at > now()
          AND state IN ('claimed', 'settle_started', 'settle_confirmed',
                        'settled', 'dispatch_started')`,
      [hexToBytea(orderRecordId), leaseToken, BAZAAR_LEASE_SECONDS],
    );
    return result.rowCount === 1;
  }

  async beginSettlement(
    orderRecordId: Hex,
    leaseToken: string,
    verifyExtensionHash: Hex | null,
    verifyBazaarStatus: BazaarIndexingStatus | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = 'settle_started', verify_extension_hash = $2,
              verify_bazaar_status = $3, updated_at = now()
        WHERE order_record_id = $1 AND state = 'claimed'
          AND processing_lease_token = $4
          AND processing_lease_expires_at > now()`,
      [
        hexToBytea(orderRecordId), nullableHex(verifyExtensionHash),
        verifyBazaarStatus, leaseToken,
      ],
    );
    return result.rowCount === 1;
  }

  async markTerminal(
    orderRecordId: Hex,
    leaseToken: string,
    expected: BazaarOrderState,
    terminal: Extract<BazaarOrderState,
      "verify_rejected" | "verify_ambiguous" | "settle_rejected" |
      "settle_ambiguous" | "evidence_rejected" | "dispatch_failed">,
    failureCode: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = $3, failure_code = $4, processing_lease_token = NULL,
              processing_lease_owner = NULL, processing_lease_expires_at = NULL,
              updated_at = now()
        WHERE order_record_id = $1 AND state = $2
          AND processing_lease_token = $5
          AND processing_lease_expires_at > now()`,
      [hexToBytea(orderRecordId), expected, terminal, failureCode, leaseToken],
    );
    return result.rowCount === 1;
  }

  async markSettlementConfirmed(input: {
    orderRecordId: Hex;
    leaseToken: string;
    transaction: Hex;
    facilitatorPayer: Hex;
    settleExtensionHash: Hex | null;
    settleBazaarStatus: BazaarIndexingStatus | null;
    rejectedReasonHash: Hex | null;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = 'settle_confirmed', settlement_transaction = $2,
              facilitator_payer = $3, settle_extension_hash = $4,
              settle_bazaar_status = $5, bazaar_rejected_reason_hash = $6,
              updated_at = now()
        WHERE order_record_id = $1 AND state = 'settle_started'
          AND processing_lease_token = $7
          AND processing_lease_expires_at > now()`,
      [
        hexToBytea(input.orderRecordId), hexToBytea(input.transaction),
        hexToBytea(input.facilitatorPayer), nullableHex(input.settleExtensionHash),
        input.settleBazaarStatus, nullableHex(input.rejectedReasonHash),
        input.leaseToken,
      ],
    );
    return result.rowCount === 1;
  }

  async markSettled(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders SET state = 'settled', updated_at = now()
        WHERE order_record_id = $1 AND state = 'settle_confirmed'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [hexToBytea(orderRecordId), leaseToken],
    );
    return result.rowCount === 1;
  }

  async beginDispatch(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders SET state = 'dispatch_started', updated_at = now()
        WHERE order_record_id = $1 AND state = 'settled'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [hexToBytea(orderRecordId), leaseToken],
    );
    return result.rowCount === 1;
  }

  async markDispatched(
    orderRecordId: Hex,
    leaseToken: string,
    taskId: string,
    taskIdHash: Hex,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = 'dispatched', task_id = $3, task_id_hash = $4,
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'dispatch_started'
          AND processing_lease_token = $2
          AND processing_lease_expires_at > now()`,
      [hexToBytea(orderRecordId), leaseToken, taskId, hexToBytea(taskIdHash)],
    );
    return result.rowCount === 1;
  }

  async getByRecordId(orderRecordId: Hex): Promise<BazaarOrder | null> {
    const result = await this.pool.query<RawOrder>(
      `SELECT ${SELECT_COLUMNS} FROM bazaar_orders WHERE order_record_id = $1`,
      [hexToBytea(orderRecordId)],
    );
    return result.rows[0] ? toOrder(result.rows[0]) : null;
  }

  async terminalizeExpiredAttempts(): Promise<{ claimed: number; settlement: number }> {
    const claimed = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = 'verify_ambiguous',
              failure_code = 'process_interrupted_before_settlement',
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE state = 'claimed' AND processing_lease_expires_at <= now()`,
    );
    const settlement = await this.pool.query(
      `UPDATE bazaar_orders
          SET state = 'settle_ambiguous',
              failure_code = 'process_interrupted_during_settlement',
              processing_lease_token = NULL, processing_lease_owner = NULL,
              processing_lease_expires_at = NULL, updated_at = now()
        WHERE state = 'settle_started' AND processing_lease_expires_at <= now()`,
    );
    return { claimed: claimed.rowCount ?? 0, settlement: settlement.rowCount ?? 0 };
  }

  async claimRecoverableOrders(
    leaseOwner: string,
    limit = 50,
  ): Promise<LeasedBazaarOrder[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ order_record_id: Buffer }>(
        `SELECT order_record_id FROM bazaar_orders
          WHERE state IN ('settle_confirmed', 'settled', 'dispatch_started')
            AND processing_lease_expires_at <= now()
          ORDER BY processing_lease_expires_at, updated_at
          LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const claimed: LeasedBazaarOrder[] = [];
      for (const row of due.rows) {
        const leaseToken = randomUUID();
        const updated = await client.query<RawLeasedOrder>(
          `UPDATE bazaar_orders
              SET processing_lease_token = $2, processing_lease_owner = $3,
                  processing_lease_expires_at =
                    now() + make_interval(secs => $4), updated_at = now()
            WHERE order_record_id = $1
            RETURNING ${SELECT_COLUMNS}, processing_lease_token`,
          [row.order_record_id, leaseToken, leaseOwner, BAZAAR_LEASE_SECONDS],
        );
        if (updated.rows[0]) {
          claimed.push({ order: toOrder(updated.rows[0]), leaseToken });
        }
      }
      await client.query("COMMIT");
      return claimed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeLifecycle(input: {
    orderRecordId: Hex;
    nonce: Hex;
    action: BazaarLifecycleAction;
    requestHash: Hex;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO bazaar_lifecycle_consumptions
         (order_record_id, challenge_nonce, action, request_hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [
        hexToBytea(input.orderRecordId), hexToBytea(input.nonce),
        input.action, hexToBytea(input.requestHash),
      ],
    );
    return result.rowCount === 1;
  }
}

function orderValues(input: ClaimOrderInput): unknown[] {
  return [
    input.orderRecordId, input.orderHandle, input.authorizationDigest,
    input.signatureDigest, input.chainId.toString(), input.token, input.payer,
    input.nonce, input.providerAgentId.toString(), input.listingEpoch,
    input.listingCommitment, input.outcomeId, input.resource, input.requestHash,
    input.offerHash, input.grossAmount.toString(), input.payTo,
    input.authorizationValidBefore.toString(),
  ].map((value) => typeof value === "string" && value.startsWith("0x")
    ? hexToBytea(value as Hex)
    : value);
}

function toOrder(row: RawOrder): BazaarOrder {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id), orderHandle: row.order_handle,
    authorizationDigest: hex(row.authorization_digest), chainId: BigInt(row.chain_id),
    token: hex(row.token), payer: hex(row.payer), nonce: hex(row.nonce),
    providerAgentId: BigInt(row.provider_agent_id), listingEpoch: hex(row.listing_epoch),
    listingCommitment: hex(row.listing_commitment), outcomeId: hex(row.outcome_id),
    resource: row.resource, requestHash: hex(row.request_hash), offerHash: hex(row.offer_hash),
    grossAmount: BigInt(row.gross_amount), payTo: hex(row.pay_to),
    authorizationValidBefore: BigInt(row.authorization_valid_before), state: row.state,
    settlementTransaction: row.settlement_transaction ? hex(row.settlement_transaction) : null,
    taskId: row.task_id, taskIdHash: row.task_id_hash ? hex(row.task_id_hash) : null,
    failureCode: row.failure_code,
  };
}

function nullableHex(value: Hex | null): Buffer | null {
  return value ? hexToBytea(value) : null;
}
