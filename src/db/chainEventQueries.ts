import type { PoolClient } from "pg";
import type {
  ChainProjectionDescriptor,
  ChainProjectionEvent,
} from "../chain/eventTypes.js";
import { compareProjectionEvents } from "../chain/eventTypes.js";
import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { eligibleChainEvent } from "./chainEligibility.js";

export interface ChainActivityRow {
  paymentId: bigint;
  txHash: Hex;
  blockNumber: bigint;
  serviceId: Hex;
  buyerAgentId: bigint;
  providerAgentId: bigint;
  amountAtomic: bigint;
  settledAt: Date;
  outcomeCode: number | null;
  confirmationCode: number;
  fulfillmentSeconds: number | null;
  refundedAtomic: bigint;
  reputationEligible: true;
  skillId: string | null;
  serviceSlug: string | null;
  serviceVersion: string | null;
  providerA2AUrl: string | null;
  walletAddress: Hex | null;
  confirmationAttestationUid: Hex | null;
}

interface ChainActivityDbRow {
  payment_id: string;
  tx_hash: Buffer;
  block_number: string;
  service_id: Buffer;
  buyer_agent_id: string;
  provider_agent_id: string;
  amount_atomic: string;
  settled_at: Date;
  outcome: number | null;
  confirmation: number;
  fulfillment_seconds: number | null;
  refunded_atomic: string;
  skill_id: string | null;
  service_slug: string | null;
  service_version: string | null;
  provider_a2a_url: string | null;
  wallet_address: string | null;
  confirmation_uid: Buffer | null;
}

interface ProjectionStateRow {
  last_indexed_block: string | null;
  chain_id: string | null;
  payment_router_address: Buffer | null;
  reputation_storage_address: Buffer | null;
  eas_address: Buffer | null;
  confirmation_schema_uid: Buffer | null;
  start_block: string | null;
  terminal_failure_category:
    | "descriptor_mismatch"
    | "projection_integrity"
    | null;
  terminal_failure_detail: string | null;
  terminal_failure_at: Date | null;
}

export interface ChainProjectionState {
  cursor: bigint | null;
  terminalFailure: {
    category: "descriptor_mismatch" | "projection_integrity";
    message: string;
    at: Date;
  } | null;
}

export class ChainProjectionDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainProjectionDescriptorError";
  }
}

export class ChainProjectionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainProjectionIntegrityError";
  }
}

const CHAIN_PROJECTION_RUNBOOK =
  "docs/runbooks/chain-projection-recovery.md";

const ACTIVITY_SELECT = `
  SELECT ce.payment_id, ce.tx_hash, ce.block_number, ce.service_id,
         ce.buyer_agent_id, ce.provider_agent_id, ce.amount_atomic,
         ce.settled_at, ce.outcome, ce.confirmation,
         ce.fulfillment_seconds, ce.refunded_atomic,
         pc.skill_id, pc.service_slug, pc.service_version,
         pc.provider_a2a_url, pc.wallet_address, ce.confirmation_uid
    FROM chain_events ce
    LEFT JOIN payment_challenges pc
           ON pc.payment_id = ce.payment_id
          AND pc.settlement_state = 'paid'
`;

const bytea = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

function toActivity(row: ChainActivityDbRow): ChainActivityRow {
  return {
    paymentId: BigInt(row.payment_id),
    txHash: hex(row.tx_hash),
    blockNumber: BigInt(row.block_number),
    serviceId: hex(row.service_id),
    buyerAgentId: BigInt(row.buyer_agent_id),
    providerAgentId: BigInt(row.provider_agent_id),
    amountAtomic: BigInt(row.amount_atomic),
    settledAt: row.settled_at,
    outcomeCode: row.outcome,
    confirmationCode: row.confirmation,
    fulfillmentSeconds: row.fulfillment_seconds,
    refundedAtomic: BigInt(row.refunded_atomic),
    reputationEligible: true,
    skillId: row.skill_id,
    serviceSlug: row.service_slug,
    serviceVersion: row.service_version,
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: (row.wallet_address as Hex | null) ?? null,
    confirmationAttestationUid: row.confirmation_uid
      ? hex(row.confirmation_uid)
      : null,
  };
}

function descriptorMatches(
  row: ProjectionStateRow,
  descriptor: ChainProjectionDescriptor,
): boolean {
  return (
    row.chain_id === descriptor.chainId.toString() &&
    row.payment_router_address?.equals(
      bytea(descriptor.paymentRouterAddress),
    ) === true &&
    row.reputation_storage_address?.equals(
      bytea(descriptor.reputationStorageAddress),
    ) === true &&
    row.eas_address?.equals(bytea(descriptor.easAddress)) === true &&
    row.confirmation_schema_uid?.equals(
      bytea(descriptor.confirmationSchemaUid),
    ) === true &&
    row.start_block === descriptor.startBlock.toString()
  );
}

function descriptorIsEmpty(row: ProjectionStateRow): boolean {
  return (
    row.last_indexed_block === null &&
    row.chain_id === null &&
    row.payment_router_address === null &&
    row.reputation_storage_address === null &&
    row.eas_address === null &&
    row.confirmation_schema_uid === null &&
    row.start_block === null
  );
}

async function lockedState(client: PoolClient): Promise<ProjectionStateRow> {
  await client.query(
    `INSERT INTO chain_indexer_state (id) VALUES (1)
     ON CONFLICT (id) DO NOTHING`,
  );
  const result = await client.query<ProjectionStateRow>(
    `SELECT last_indexed_block, chain_id, payment_router_address,
            reputation_storage_address, eas_address,
            confirmation_schema_uid, start_block,
            terminal_failure_category, terminal_failure_detail,
            terminal_failure_at
       FROM chain_indexer_state
      WHERE id = 1
      FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("chain projection state row is unavailable");
  return row;
}

async function adoptDescriptor(
  client: PoolClient,
  descriptor: ChainProjectionDescriptor,
): Promise<void> {
  await client.query(
    `UPDATE chain_indexer_state
        SET chain_id = $1,
            payment_router_address = $2,
            reputation_storage_address = $3,
            eas_address = $4,
            confirmation_schema_uid = $5,
            start_block = $6
      WHERE id = 1`,
    [
      descriptor.chainId,
      bytea(descriptor.paymentRouterAddress),
      bytea(descriptor.reputationStorageAddress),
      bytea(descriptor.easAddress),
      bytea(descriptor.confirmationSchemaUid),
      descriptor.startBlock.toString(),
    ],
  );
}

function assertBaseRowUpdated(
  rowCount: number | null,
  event: Exclude<
    ChainProjectionEvent,
    { kind: "payment_settled" | "confirmation_revoked" }
  >,
): void {
  if (rowCount === 1) return;
  throw new ChainProjectionIntegrityError(
    `projection event ${event.kind} for payment ${event.paymentId} at block ` +
      `${event.blockNumber} has no matching settlement; ` +
      "CHAIN_INDEXER_START_BLOCK may be too late or projection state was reset inconsistently; " +
      `follow ${CHAIN_PROJECTION_RUNBOOK}`,
  );
}

async function applyEvent(
  client: PoolClient,
  event: ChainProjectionEvent,
): Promise<void> {
  if (event.kind === "payment_settled") {
    const settledAt = new Date(Number(event.blockTimestamp) * 1000);
    if (!Number.isFinite(settledAt.getTime()) || event.blockTimestamp <= 0n) {
      throw new ChainProjectionIntegrityError(
        `payment ${event.paymentId} has an invalid block timestamp`,
      );
    }
    await client.query(
      `INSERT INTO chain_events
         (payment_id, tx_hash, block_number, service_id, buyer_agent_id,
          provider_agent_id, amount_atomic, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (payment_id) DO UPDATE
       SET tx_hash = EXCLUDED.tx_hash,
           block_number = EXCLUDED.block_number,
           service_id = EXCLUDED.service_id,
           buyer_agent_id = EXCLUDED.buyer_agent_id,
           provider_agent_id = EXCLUDED.provider_agent_id,
           amount_atomic = EXCLUDED.amount_atomic,
           settled_at = EXCLUDED.settled_at`,
      [
        event.paymentId.toString(),
        bytea(event.transactionHash),
        event.blockNumber.toString(),
        bytea(event.serviceId),
        event.buyerAgentId.toString(),
        event.providerAgentId.toString(),
        event.totalAmount.toString(),
        settledAt,
      ],
    );
    return;
  }

  if (event.kind === "confirmation_revoked") {
    await client.query(
      `UPDATE chain_events
          SET confirmation = 0, confirmation_uid = NULL
        WHERE confirmation_uid = $1`,
      [bytea(event.attestationUid)],
    );
    return;
  }

  if (event.kind === "refunded") {
    const result = await client.query(
      `UPDATE chain_events
          SET refunded_atomic = GREATEST(refunded_atomic, $2)
        WHERE payment_id = $1`,
      [event.paymentId.toString(), event.cumulativeRefunded.toString()],
    );
    assertBaseRowUpdated(result.rowCount, event);
    return;
  }

  const identityParams = [
    event.paymentId.toString(),
    event.providerAgentId.toString(),
    event.buyerAgentId.toString(),
    bytea(event.serviceId),
  ];
  if (event.kind === "payment_recorded") {
    const result = await client.query(
      `UPDATE chain_events
          SET reputation_eligible = $5
        WHERE payment_id = $1
          AND provider_agent_id = $2
          AND buyer_agent_id = $3
          AND service_id = $4`,
      [...identityParams, event.reputationEligible],
    );
    assertBaseRowUpdated(result.rowCount, event);
    return;
  }
  if (event.kind === "outcome_recorded") {
    const result = await client.query(
      `UPDATE chain_events
          SET outcome = $5, fulfillment_seconds = $6, outcome_uid = $7
        WHERE payment_id = $1
          AND provider_agent_id = $2
          AND buyer_agent_id = $3
          AND service_id = $4`,
      [
        ...identityParams,
        event.outcomeCode,
        event.fulfillmentSeconds.toString(),
        bytea(event.attestationUid),
      ],
    );
    assertBaseRowUpdated(result.rowCount, event);
    return;
  }
  const result = await client.query(
    `UPDATE chain_events
        SET confirmation = $5, confirmation_uid = $6
      WHERE payment_id = $1
        AND provider_agent_id = $2
        AND buyer_agent_id = $3
        AND service_id = $4`,
    [...identityParams, event.confirmationCode, bytea(event.attestationUid)],
  );
  assertBaseRowUpdated(result.rowCount, event);
}

export function createChainEventQueries(pool: Pool) {
  const list = async (
    condition: string,
    params: unknown[],
  ): Promise<ChainActivityRow[]> => {
    const suffix = condition ? ` AND ${condition}` : "";
    const result = await pool.query<ChainActivityDbRow>(
      `${ACTIVITY_SELECT}
       WHERE ${eligibleChainEvent("ce.")}${suffix}
       ORDER BY ce.settled_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toActivity);
  };

  return {
    async getOrAdoptChainProjection(
      descriptor: ChainProjectionDescriptor,
    ): Promise<bigint | null> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const row = await lockedState(client);
        if (descriptorIsEmpty(row)) {
          await adoptDescriptor(client, descriptor);
        } else if (!descriptorMatches(row, descriptor)) {
          throw new ChainProjectionDescriptorError(
            "stored chain projection descriptor conflicts with runtime configuration; " +
              `follow ${CHAIN_PROJECTION_RUNBOOK}`,
          );
        }
        await client.query("COMMIT");
        return row.last_indexed_block === null
          ? null
          : BigInt(row.last_indexed_block);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getChainProjectionState(
      descriptor: ChainProjectionDescriptor,
    ): Promise<ChainProjectionState> {
      const result = await pool.query<ProjectionStateRow>(
        `SELECT last_indexed_block, chain_id, payment_router_address,
                reputation_storage_address, eas_address,
                confirmation_schema_uid, start_block,
                terminal_failure_category, terminal_failure_detail,
                terminal_failure_at
           FROM chain_indexer_state
          WHERE id = 1`,
      );
      const row = result.rows[0];
      if (!row || !descriptorMatches(row, descriptor)) {
        throw new ChainProjectionDescriptorError(
          "stored chain projection descriptor conflicts with runtime configuration; " +
            `follow ${CHAIN_PROJECTION_RUNBOOK}`,
        );
      }
      return {
        cursor:
          row.last_indexed_block === null
            ? null
            : BigInt(row.last_indexed_block),
        terminalFailure:
          row.terminal_failure_category &&
          row.terminal_failure_detail &&
          row.terminal_failure_at
            ? {
                category: row.terminal_failure_category,
                message: row.terminal_failure_detail,
                at: row.terminal_failure_at,
              }
            : null,
      };
    },

    async tryWithChainProjectionLock<T>(
      action: () => Promise<T>,
    ): Promise<{ acquired: false } | { acquired: true; result: T }> {
      const client = await pool.connect();
      const lockName = "daski:chain-events-indexer:v2";
      try {
        const lock = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(
             hashtextextended($1, 0)
           ) AS acquired`,
          [lockName],
        );
        if (!lock.rows[0]?.acquired) return { acquired: false };
        try {
          return { acquired: true, result: await action() };
        } finally {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lockName],
          );
        }
      } finally {
        client.release();
      }
    },

    async recordChainProjectionTerminalFailure(input: {
      category: "descriptor_mismatch" | "projection_integrity";
      message: string;
    }): Promise<void> {
      await pool.query(
        `UPDATE chain_indexer_state
            SET terminal_failure_category = COALESCE(
                  terminal_failure_category, $1
                ),
                terminal_failure_detail = COALESCE(
                  terminal_failure_detail, $2
                ),
                terminal_failure_at = COALESCE(
                  terminal_failure_at, now()
                )
          WHERE id = 1`,
        [input.category, input.message.slice(0, 2000)],
      );
    },

    async applyChainProjectionPage(input: {
      descriptor: ChainProjectionDescriptor;
      fromBlock: bigint;
      toBlock: bigint;
      events: ChainProjectionEvent[];
    }): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const state = await lockedState(client);
        if (!descriptorMatches(state, input.descriptor)) {
          throw new ChainProjectionDescriptorError(
            "chain projection descriptor changed while indexing; " +
              `follow ${CHAIN_PROJECTION_RUNBOOK}`,
          );
        }
        const expectedPrevious =
          input.fromBlock === input.descriptor.startBlock
            ? null
            : input.fromBlock - 1n;
        const storedPrevious =
          state.last_indexed_block === null
            ? null
            : BigInt(state.last_indexed_block);
        if (storedPrevious !== expectedPrevious) {
          throw new ChainProjectionIntegrityError(
            "chain projection cursor changed while applying a page",
          );
        }
        for (const event of [...input.events].sort(compareProjectionEvents)) {
          await applyEvent(client, event);
        }
        await client.query(
          `UPDATE chain_indexer_state
              SET last_indexed_block = $1, last_indexed_at = now()
            WHERE id = 1`,
          [input.toBlock.toString()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    listRecentChainActivity: (limit: number) => list("", [limit]),

    listRecentChainActivityByProvider: (
      providerAgentId: bigint,
      limit: number,
    ) => list("ce.provider_agent_id = $1", [providerAgentId.toString(), limit]),

    listRecentChainActivityByServiceId: (serviceId: Hex, limit: number) =>
      list("ce.service_id = $1", [bytea(serviceId), limit]),

    listRecentChainActivityByBuyer: (buyerAgentId: bigint, limit: number) =>
      list("ce.buyer_agent_id = $1", [buyerAgentId.toString(), limit]),
  };
}
