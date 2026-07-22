import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

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
  confirmation_attestation_uid: Buffer | null;
}

const ACTIVITY_SELECT = `
  SELECT ce.payment_id, ce.tx_hash, ce.block_number, ce.service_id,
         ce.buyer_agent_id, ce.provider_agent_id, ce.amount_atomic,
         ce.settled_at, ce.outcome, ce.confirmation,
         ce.fulfillment_seconds, ce.refunded_atomic,
         pc.skill_id, pc.service_slug, pc.service_version,
         pc.provider_a2a_url, pc.wallet_address,
         pc.confirmation_attestation_uid
    FROM chain_events ce
    LEFT JOIN payment_challenges pc
           ON pc.payment_id = ce.payment_id
          AND pc.settlement_state = 'paid'
`;

const bytea = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");
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
    skillId: row.skill_id,
    serviceSlug: row.service_slug,
    serviceVersion: row.service_version,
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: (row.wallet_address as Hex | null) ?? null,
    confirmationAttestationUid: row.confirmation_attestation_uid
      ? hex(row.confirmation_attestation_uid)
      : null,
  };
}

export function createChainEventQueries(pool: Pool) {
  const list = async (
    where: string,
    params: unknown[],
  ): Promise<ChainActivityRow[]> => {
    const result = await pool.query<ChainActivityDbRow>(
      `${ACTIVITY_SELECT} ${where}`,
      params,
    );
    return result.rows.map(toActivity);
  };

  return {
    async getLastIndexedBlock(): Promise<bigint> {
      const result = await pool.query<{ last_indexed_block: string }>(
        `SELECT last_indexed_block FROM chain_indexer_state WHERE id = 1`,
      );
      return result.rows[0]
        ? BigInt(result.rows[0].last_indexed_block)
        : 0n;
    },

    async setLastIndexedBlock(blockNumber: bigint): Promise<void> {
      await pool.query(
        `INSERT INTO chain_indexer_state (id, last_indexed_block, last_indexed_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE
         SET last_indexed_block = EXCLUDED.last_indexed_block,
             last_indexed_at = EXCLUDED.last_indexed_at`,
        [blockNumber.toString()],
      );
    },

    async upsertChainEvent(args: {
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
    }): Promise<void> {
      await pool.query(
        `INSERT INTO chain_events
           (payment_id, tx_hash, block_number, service_id, buyer_agent_id,
            provider_agent_id, amount_atomic, settled_at, outcome,
            confirmation, fulfillment_seconds, refunded_atomic,
            last_refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (payment_id) DO UPDATE
         SET tx_hash = EXCLUDED.tx_hash,
             block_number = EXCLUDED.block_number,
             service_id = EXCLUDED.service_id,
             buyer_agent_id = EXCLUDED.buyer_agent_id,
             provider_agent_id = EXCLUDED.provider_agent_id,
             amount_atomic = EXCLUDED.amount_atomic,
             settled_at = EXCLUDED.settled_at,
             outcome = EXCLUDED.outcome,
             confirmation = EXCLUDED.confirmation,
             fulfillment_seconds = EXCLUDED.fulfillment_seconds,
             refunded_atomic = EXCLUDED.refunded_atomic,
             last_refreshed_at = now()`,
        [
          args.paymentId.toString(),
          bytea(args.txHash),
          args.blockNumber.toString(),
          bytea(args.serviceId),
          args.buyerAgentId.toString(),
          args.providerAgentId.toString(),
          args.amountAtomic.toString(),
          args.settledAt,
          args.outcomeCode,
          args.confirmationCode,
          args.fulfillmentSeconds,
          args.refundedAtomic.toString(),
        ],
      );
    },

    async refreshChainEvent(args: {
      paymentId: bigint;
      outcomeCode: number | null;
      confirmationCode: number;
      fulfillmentSeconds: number | null;
      refundedAtomic: bigint;
    }): Promise<void> {
      await pool.query(
        `UPDATE chain_events
         SET outcome = $2, confirmation = $3, fulfillment_seconds = $4,
             refunded_atomic = $5, last_refreshed_at = now()
         WHERE payment_id = $1`,
        [
          args.paymentId.toString(),
          args.outcomeCode,
          args.confirmationCode,
          args.fulfillmentSeconds,
          args.refundedAtomic.toString(),
        ],
      );
    },

    async listStaleChainEvents(
      cutoff: Date,
      limit: number,
    ): Promise<Array<{ paymentId: bigint }>> {
      const result = await pool.query<{ payment_id: string }>(
        `SELECT payment_id FROM chain_events
         WHERE (confirmation = 0 OR refunded_atomic = 0)
           AND last_refreshed_at < $1
         ORDER BY last_refreshed_at ASC
         LIMIT $2`,
        [cutoff, limit],
      );
      return result.rows.map((row) => ({
        paymentId: BigInt(row.payment_id),
      }));
    },

    listRecentChainActivity: (limit: number) =>
      list("ORDER BY ce.settled_at DESC LIMIT $1", [limit]),

    listRecentChainActivityByProvider: (
      providerAgentId: bigint,
      limit: number,
    ) =>
      list(
        "WHERE ce.provider_agent_id = $1 ORDER BY ce.settled_at DESC LIMIT $2",
        [providerAgentId.toString(), limit],
      ),

    listRecentChainActivityByServiceId: (serviceId: Hex, limit: number) =>
      list(
        "WHERE ce.service_id = $1 ORDER BY ce.settled_at DESC LIMIT $2",
        [bytea(serviceId), limit],
      ),

    listRecentChainActivityByBuyer: (buyerAgentId: bigint, limit: number) =>
      list(
        "WHERE ce.buyer_agent_id = $1 ORDER BY ce.settled_at DESC LIMIT $2",
        [buyerAgentId.toString(), limit],
      ),
  };
}
