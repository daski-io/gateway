import { randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";
import { withActiveBazaarRuntimeManifest } from "./runtimeManifestStore.js";
import {
  BAZAAR_ORDER_SELECT_COLUMNS,
  toBazaarOrder,
  type RawBazaarOrder,
} from "./orderRows.js";
import type {
  BazaarObservationOriginState,
  BazaarOrder,
  BazaarOrderState,
} from "./types.js";

const OBSERVATION_LEASE_SECONDS = 120;

export interface LeasedBazaarObservation {
  order: BazaarOrder;
  originState: BazaarObservationOriginState;
  leaseToken: string;
}

export async function markBazaarObservationRequired(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  expected: BazaarOrderState;
  terminal: BazaarObservationOriginState;
  failureCode: string;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const transitioned = await client.query(
      `UPDATE bazaar_orders
          SET state = $3, failure_code = $4, processing_lease_token = NULL,
              processing_lease_owner = NULL, processing_lease_expires_at = NULL,
              updated_at = now()
        WHERE order_record_id = $1 AND state = $2
          AND processing_lease_token = $5
          AND processing_lease_expires_at > now()
        RETURNING order_record_id`,
      [
        hexToBytea(input.orderRecordId), input.expected, input.terminal,
        input.failureCode, input.leaseToken,
      ],
    );
    if (transitioned.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO bazaar_settlement_observations
         (order_record_id, origin_state) VALUES ($1, $2)`,
      [hexToBytea(input.orderRecordId), input.terminal],
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

export async function terminalizeExpiredBazaarAttemptsInTransaction(
  client: import("pg").PoolClient,
): Promise<{ claimed: number; settlement: number }> {
  const claimed = await terminalizeExpired(
    client,
    "attempt_opened",
    "verify_ambiguous",
    "process_interrupted_before_settlement",
  );
  const settlement = await terminalizeExpired(
    client,
    "settle_started",
    "settle_ambiguous",
    "process_interrupted_during_settlement",
  );
  return { claimed, settlement };
}

export async function claimBazaarObservation(input: {
  pool: Pool;
  leaseOwner: string;
  nowSeconds: bigint;
  finalityWindowSeconds: number;
  runtimeManifest: ApprovedBazaarRuntimeManifestIdentity;
}): Promise<LeasedBazaarObservation | null> {
  const result = await withActiveBazaarRuntimeManifest({
    pool: input.pool,
    identity: input.runtimeManifest,
    action: async (client) => {
      const due = await client.query<{ order_record_id: Buffer }>(
        `SELECT j.order_record_id
           FROM bazaar_settlement_observations j
           JOIN bazaar_orders o USING (order_record_id)
          WHERE (
            (j.state = 'pending' AND j.next_attempt_at <= now())
            OR (j.state = 'observing' AND j.lease_expires_at <= now())
          )
            AND o.state = j.origin_state
            AND o.authorization_valid_before + $1 <= $2
          ORDER BY j.next_attempt_at, j.updated_at
          LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [input.finalityWindowSeconds, input.nowSeconds.toString()],
      );
      const row = due.rows[0];
      if (!row) return null;
      const leaseToken = randomUUID();
      const claimed = await client.query<{
        origin_state: BazaarObservationOriginState;
        lease_token: string;
      }>(
        `UPDATE bazaar_settlement_observations
            SET state = 'observing', attempt_count = attempt_count + 1,
                lease_token = $2, lease_owner = $3,
                lease_expires_at = now() + make_interval(secs => $4),
                updated_at = now()
          WHERE order_record_id = $1
          RETURNING origin_state, lease_token`,
        [row.order_record_id, leaseToken, input.leaseOwner,
          OBSERVATION_LEASE_SECONDS],
      );
      const order = await client.query<RawBazaarOrder>(
        `SELECT ${BAZAAR_ORDER_SELECT_COLUMNS} FROM bazaar_orders
          WHERE order_record_id = $1`,
        [row.order_record_id],
      );
      const claimedRow = claimed.rows[0];
      const orderRow = order.rows[0];
      if (!claimedRow || !orderRow) {
        throw new Error("Bazaar observation claim disappeared");
      }
      return {
        order: toBazaarOrder(orderRow),
        originState: claimedRow.origin_state,
        leaseToken: claimedRow.lease_token,
      };
    },
  });
  return result.active ? result.value : null;
}

export async function renewBazaarObservationLease(
  pool: Pool,
  runtimeManifest: ApprovedBazaarRuntimeManifestIdentity,
  orderRecordId: Hex,
  leaseToken: string,
): Promise<boolean> {
  const result = await withActiveBazaarRuntimeManifest({
    pool,
    identity: runtimeManifest,
    action: async (client) => {
      const renewed = await client.query(
        `UPDATE bazaar_settlement_observations
            SET lease_expires_at = now() + make_interval(secs => $3),
                updated_at = now()
          WHERE order_record_id = $1 AND state = 'observing'
            AND lease_token = $2 AND lease_expires_at > now()`,
        [hexToBytea(orderRecordId), leaseToken, OBSERVATION_LEASE_SECONDS],
      );
      return renewed.rowCount === 1;
    },
  });
  return result.active && result.value;
}

export async function deferBazaarObservation(input: {
  pool: Pool;
  orderRecordId: Hex;
  leaseToken: string;
  retryDelaySeconds: number;
}): Promise<boolean> {
  const result = await input.pool.query(
    `UPDATE bazaar_settlement_observations
        SET state = 'pending', next_attempt_at =
              now() + make_interval(secs => $3),
            lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = now()
      WHERE order_record_id = $1 AND state = 'observing'
        AND lease_token = $2 AND lease_expires_at > now()`,
    [hexToBytea(input.orderRecordId), input.leaseToken, input.retryDelaySeconds],
  );
  return result.rowCount === 1;
}

async function terminalizeExpired(
  client: import("pg").PoolClient,
  expected: "attempt_opened" | "settle_started",
  terminal: "verify_ambiguous" | "settle_ambiguous",
  failureCode: string,
): Promise<number> {
  const result = await client.query(
    `WITH transitioned AS (
       UPDATE bazaar_orders
          SET state = $2, failure_code = $3, processing_lease_token = NULL,
              processing_lease_owner = NULL, processing_lease_expires_at = NULL,
              updated_at = now()
        WHERE state = $1 AND processing_lease_expires_at <= now()
        RETURNING order_record_id
     )
     INSERT INTO bazaar_settlement_observations (order_record_id, origin_state)
       SELECT order_record_id, $2 FROM transitioned
     RETURNING order_record_id`,
    [expected, terminal, failureCode],
  );
  return result.rowCount ?? 0;
}
