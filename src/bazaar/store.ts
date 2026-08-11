import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type {
  BazaarLifecycleAction,
  BazaarFinancialStatus,
  BazaarOrder,
  BazaarOrderState,
  BazaarRefundReason,
  BazaarRefundRiskPolicy,
  BazaarSettlementCapacityPolicy,
} from "./types.js";
import type { BazaarIndexingStatus } from "./extensionResponse.js";
import {
  listingSettlementCapacityAvailable,
  settlementCapacityAvailable,
} from "./settlementCapacity.js";
import {
  MAXIMUM_FUTURE_CLOCK_SKEW_SECONDS,
  MINIMUM_SETTLEMENT_REMAINING_SECONDS,
} from "./paymentPolicy.js";
import {
  reserveBazaarExposure,
} from "./refundAccounting.js";
import { refundRiskHeadroomAvailable } from "./refundPolicy.js";
import {
  getBazaarFinancialStatus,
  markBazaarDispatched,
  markBazaarDispatchAmbiguous,
  markBazaarDispatchRefundDue,
  markBazaarSettled,
} from "./financialStore.js";
import {
  BAZAAR_ORDER_SELECT_COLUMNS,
  toBazaarOrder,
  type RawBazaarOrder,
} from "./orderRows.js";
import {
  markBazaarObservationRequired,
  terminalizeExpiredBazaarAttempts,
} from "./observationLeaseStore.js";

interface RawLeasedOrder extends RawBazaarOrder {
  processing_lease_token: string;
}

export interface ClaimOrderInput extends Omit<
  BazaarOrder,
  "state" | "settlementTransaction" | "taskId" | "taskIdHash" | "failureCode"
> {
  signatureDigest: Hex;
  authorizationValidAfter: bigint;
  paidRetryReceivedAt: bigint;
  paymentMaxTimeoutSeconds: bigint;
}

export interface LeasedBazaarOrder {
  order: BazaarOrder;
  leaseToken: string;
}

export const BAZAAR_LEASE_SECONDS = 120;

export class BazaarOrderStore {
  constructor(private readonly pool: Pool) {}

  async hasLifecycleDomain(chainId: bigint, payTo: Hex): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM bazaar_lifecycle_domains
        WHERE chain_id = $1 AND pay_to = $2
          AND (active OR accept_until > now())
        LIMIT 1`,
      [chainId.toString(), hexToBytea(payTo)],
    );
    return result.rowCount === 1;
  }

  async hasBlockingIncident(listingCommitment: Hex): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM bazaar_orders
        WHERE listing_commitment = $1 AND state IN (
          'verify_ambiguous', 'settle_ambiguous', 'evidence_rejected',
          'dispatch_ambiguous', 'dispatch_failed',
          'ambiguous_expired_no_transfer', 'invalid_evidence_expired_no_transfer',
          'unapproved_direct_inbound', 'settlement_refund_due'
        ) LIMIT 1`,
      [hexToBytea(listingCommitment)],
    );
    return result.rowCount === 1;
  }

  async findByAuthorization(input: ClaimOrderInput): Promise<BazaarOrder | null> {
    const result = await this.pool.query<RawBazaarOrder>(
      `SELECT ${BAZAAR_ORDER_SELECT_COLUMNS} FROM bazaar_orders
        WHERE authorization_digest = $1
           OR (chain_id = $2 AND token = $3 AND payer = $4 AND nonce = $5)`,
      [
        hexToBytea(input.authorizationDigest), input.chainId.toString(),
        hexToBytea(input.token), hexToBytea(input.payer), hexToBytea(input.nonce),
      ],
    );
    if (result.rows.length > 1) {
      throw new Error("Bazaar authorization uniqueness invariant violated");
    }
    return result.rows[0] ? toBazaarOrder(result.rows[0]) : null;
  }

  async hasSettlementCapacity(
    input: ClaimOrderInput,
    policy: BazaarSettlementCapacityPolicy,
  ): Promise<boolean> {
    return settlementCapacityAvailable({
      queryable: this.pool,
      policy,
      listingCommitment: input.listingCommitment,
      payer: input.payer,
    });
  }

  async hasListingSettlementCapacity(
    listingCommitment: Hex,
    policy: BazaarSettlementCapacityPolicy,
  ): Promise<boolean> {
    return listingSettlementCapacityAvailable({
      queryable: this.pool,
      policy,
      listingCommitment,
    });
  }

  async hasRefundRiskHeadroom(
    providerAgentId: bigint,
    grossAmount: bigint,
    policy: BazaarRefundRiskPolicy,
  ): Promise<boolean> {
    return refundRiskHeadroomAvailable({
      queryable: this.pool,
      providerAgentId,
      grossAmount,
      policy,
    });
  }

  async claimWithCapacity(
    input: ClaimOrderInput,
    leaseOwner: string,
    settlementPolicy: BazaarSettlementCapacityPolicy,
    refundPolicy: BazaarRefundRiskPolicy,
    nowSeconds: () => bigint,
  ): Promise<
    | { kind: "claimed"; created: boolean; order: BazaarOrder; leaseToken: string | null }
    | { kind: "capacity_unavailable"; dimension: "settlement" | "refund_risk" }
    | { kind: "authorization_expired" }
  > {
    const leaseToken = randomUUID();
    const values = orderValues(input);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
        const existing = await client.query<RawBazaarOrder>(
          `SELECT ${BAZAAR_ORDER_SELECT_COLUMNS} FROM bazaar_orders
            WHERE authorization_digest = $1
               OR (chain_id = $2 AND token = $3 AND payer = $4 AND nonce = $5)`,
          [
            hexToBytea(input.authorizationDigest), input.chainId.toString(),
            hexToBytea(input.token), hexToBytea(input.payer), hexToBytea(input.nonce),
          ],
        );
        if (existing.rows.length > 1) {
          throw new Error("Bazaar authorization uniqueness invariant violated");
        }
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return {
            kind: "claimed",
            created: false,
            order: toBazaarOrder(existing.rows[0]),
            leaseToken: null,
          };
        }
        const available = await settlementCapacityAvailable({
          queryable: client,
          policy: settlementPolicy,
          listingCommitment: input.listingCommitment,
          payer: input.payer,
        });
        const refundHeadroom = await refundRiskHeadroomAvailable({
          queryable: client,
          providerAgentId: input.providerAgentId,
          grossAmount: input.grossAmount,
          policy: refundPolicy,
        });
        const openedAt = nowSeconds();
        if (!authorizationWindowIsOpen(input, openedAt)) {
          await client.query("COMMIT");
          return { kind: "authorization_expired" };
        }
        if (!available) {
          await client.query("COMMIT");
          return { kind: "capacity_unavailable", dimension: "settlement" };
        }
        if (!refundHeadroom) {
          await client.query("COMMIT");
          return { kind: "capacity_unavailable", dimension: "refund_risk" };
        }
        const inserted = await client.query<RawBazaarOrder>(
          `INSERT INTO bazaar_orders (
           order_record_id, order_handle, authorization_digest,
           authorization_signature_digest, chain_id, token, payer, nonce,
           provider_agent_id, listing_epoch, listing_commitment, outcome_id,
           resource, request_hash, offer_hash, gross_amount, pay_to,
           authorization_valid_before, state, processing_lease_token,
           processing_lease_owner, processing_lease_expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, 'attempt_opened', $19, $20,
           now() + make_interval(secs => $21)
         ) RETURNING ${BAZAAR_ORDER_SELECT_COLUMNS}`,
          [...values, leaseToken, leaseOwner, BAZAAR_LEASE_SECONDS],
        );
        if (!inserted.rows[0]) throw new Error("Bazaar order insert returned no row");
        const order = toBazaarOrder(inserted.rows[0]);
        await reserveBazaarExposure(client, order);
        await client.query("COMMIT");
        return {
          kind: "claimed",
          created: true,
          order,
          leaseToken,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (!retryableAdmissionConflict(error)) throw error;
      } finally {
        client.release();
      }
    }
    const existing = await this.findByAuthorization(input);
    if (existing) {
      return { kind: "claimed", created: false, order: existing, leaseToken: null };
    }
    const refundHeadroom = await refundRiskHeadroomAvailable({
      queryable: this.pool,
      providerAgentId: input.providerAgentId,
      grossAmount: input.grossAmount,
      policy: refundPolicy,
    });
    return {
      kind: "capacity_unavailable",
      dimension: refundHeadroom ? "settlement" : "refund_risk",
    };
  }

  async renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE bazaar_orders
          SET processing_lease_expires_at =
                now() + make_interval(secs => $3), updated_at = now()
        WHERE order_record_id = $1 AND processing_lease_token = $2
          AND processing_lease_expires_at > now()
          AND state IN ('attempt_opened', 'settle_started', 'settle_confirmed',
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
        WHERE order_record_id = $1 AND state = 'attempt_opened'
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
      "settle_ambiguous" | "evidence_rejected">,
    failureCode: string,
  ): Promise<boolean> {
    return markBazaarObservationRequired({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      expected,
      terminal,
      failureCode,
    });
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
    return markBazaarSettled(this.pool, orderRecordId, leaseToken);
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
    return markBazaarDispatched({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      taskId,
      taskIdHash,
    });
  }

  async markDispatchAmbiguous(
    orderRecordId: Hex,
    leaseToken: string,
    failureCode: string,
  ): Promise<boolean> {
    return markBazaarDispatchAmbiguous({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      failureCode,
    });
  }

  async markDispatchRefundDue(input: {
    orderRecordId: Hex;
    leaseToken: string;
    expected: "settled" | "dispatch_started";
    reason: Extract<BazaarRefundReason,
      "PROVIDER_COMPLIANCE_FAILURE" | "PROVIDER_FULFILLMENT_FAILURE">;
    policy: BazaarRefundRiskPolicy;
    failureCode: string;
  }): Promise<boolean> {
    return markBazaarDispatchRefundDue({ ...input, pool: this.pool });
  }

  async getByRecordId(orderRecordId: Hex): Promise<BazaarOrder | null> {
    const result = await this.pool.query<RawBazaarOrder>(
      `SELECT ${BAZAAR_ORDER_SELECT_COLUMNS} FROM bazaar_orders WHERE order_record_id = $1`,
      [hexToBytea(orderRecordId)],
    );
    return result.rows[0] ? toBazaarOrder(result.rows[0]) : null;
  }

  async getFinancialStatus(orderRecordId: Hex): Promise<BazaarFinancialStatus | null> {
    return getBazaarFinancialStatus(this.pool, orderRecordId);
  }

  async terminalizeExpiredAttempts(): Promise<{ claimed: number; settlement: number }> {
    return terminalizeExpiredBazaarAttempts(this.pool);
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
          WHERE (
            state IN ('settle_confirmed', 'settled', 'dispatch_started')
            AND processing_lease_expires_at <= now()
          ) OR state = 'dispatch_ambiguous'
          ORDER BY processing_lease_expires_at, updated_at
          LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      const claimed: LeasedBazaarOrder[] = [];
      for (const row of due.rows) {
        const leaseToken = randomUUID();
        const updated = await client.query<RawLeasedOrder>(
          `UPDATE bazaar_orders
              SET state = CASE WHEN state = 'dispatch_ambiguous'
                    THEN 'dispatch_started' ELSE state END,
                  processing_lease_token = $2, processing_lease_owner = $3,
                  processing_lease_expires_at =
                    now() + make_interval(secs => $4), updated_at = now()
            WHERE order_record_id = $1
            RETURNING ${BAZAAR_ORDER_SELECT_COLUMNS}, processing_lease_token`,
          [row.order_record_id, leaseToken, leaseOwner, BAZAAR_LEASE_SECONDS],
        );
        if (updated.rows[0]) {
          claimed.push({ order: toBazaarOrder(updated.rows[0]), leaseToken });
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

function nullableHex(value: Hex | null): Buffer | null {
  return value ? hexToBytea(value) : null;
}

function authorizationWindowIsOpen(
  input: ClaimOrderInput,
  openedAt: bigint,
): boolean {
  return input.authorizationValidAfter <= input.paidRetryReceivedAt &&
    input.authorizationValidBefore > input.authorizationValidAfter &&
    input.authorizationValidBefore >=
      openedAt + MINIMUM_SETTLEMENT_REMAINING_SECONDS &&
    input.authorizationValidBefore <= input.paidRetryReceivedAt +
      input.paymentMaxTimeoutSeconds + MAXIMUM_FUTURE_CLOCK_SKEW_SECONDS;
}

function retryableAdmissionConflict(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "40001" || code === "23505";
}
