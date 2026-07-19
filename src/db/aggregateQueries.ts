import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

interface Aggregate {
  count: number;
  totalAtomic: bigint;
}

export interface BuyerActivityAggregate {
  transactionCount: number;
  totalSpentAtomic: bigint;
  totalRefundedAtomic: bigint;
  refundCount: number;
  completedCount: number;
  failedCount: number;
  canceledCount: number;
  confirmedCount: number;
  notConfirmedCount: number;
  uniqueProviderCount: number;
  uniqueSkillCount: number;
  fulfillmentSumSeconds: number;
  fulfillmentSampleSize: number;
  firstSettledAt: Date | null;
  lastSettledAt: Date | null;
}

export interface BuyerVolumeRow {
  agentId: bigint;
  transactionCount: number;
  totalSpentAtomic: bigint;
  lastSettledAt: Date;
  resolvedName: string | null;
}

export function createAggregateQueries(pool: Pool) {
  const aggregate = async (
    where = "",
    params: unknown[] = [],
  ): Promise<Aggregate> => {
    const result = await pool.query<{ count: string; total_atomic: string }>(
      `SELECT COUNT(*)::bigint AS count,
              COALESCE(SUM(amount_atomic), 0)::numeric AS total_atomic
         FROM chain_events ${where}`,
      params,
    );
    const row = result.rows[0];
    return {
      count: Number(row.count),
      totalAtomic: BigInt(row.total_atomic),
    };
  };

  return {
    getPaidAggregate: () => aggregate(),

    async buyerHasChainActivity(buyerAgentId: bigint): Promise<boolean> {
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM chain_events WHERE buyer_agent_id = $1
         ) AS exists`,
        [buyerAgentId.toString()],
      );
      return result.rows[0]?.exists ?? false;
    },

    getProviderSpend: (providerAgentId: bigint) =>
      aggregate("WHERE provider_agent_id = $1", [
        providerAgentId.toString(),
      ]),

    getServiceSpend: (serviceId: Hex) =>
      aggregate("WHERE service_id = $1", [
        Buffer.from(serviceId.slice(2), "hex"),
      ]),

    async aggregateChainActivityByBuyer(
      buyerAgentId: bigint,
    ): Promise<BuyerActivityAggregate> {
      const result = await pool.query<{
        transaction_count: string;
        total_spent_atomic: string;
        total_refunded_atomic: string;
        refund_count: string;
        completed_count: string;
        failed_count: string;
        canceled_count: string;
        confirmed_count: string;
        not_confirmed_count: string;
        unique_provider_count: string;
        unique_skill_count: string;
        fulfillment_sum_seconds: string;
        fulfillment_sample_size: string;
        first_settled_at: Date | null;
        last_settled_at: Date | null;
      }>(
        `SELECT COUNT(*)::bigint AS transaction_count,
                COALESCE(SUM(ce.amount_atomic), 0)::numeric AS total_spent_atomic,
                COALESCE(SUM(ce.refunded_atomic), 0)::numeric AS total_refunded_atomic,
                COUNT(*) FILTER (WHERE ce.refunded_atomic > 0)::bigint AS refund_count,
                COUNT(*) FILTER (WHERE ce.outcome = 0)::bigint AS completed_count,
                COUNT(*) FILTER (WHERE ce.outcome = 1)::bigint AS failed_count,
                COUNT(*) FILTER (WHERE ce.outcome = 2)::bigint AS canceled_count,
                COUNT(*) FILTER (WHERE ce.confirmation = 1)::bigint AS confirmed_count,
                COUNT(*) FILTER (WHERE ce.confirmation = 2)::bigint AS not_confirmed_count,
                COUNT(DISTINCT ce.provider_agent_id)::bigint AS unique_provider_count,
                COUNT(DISTINCT pc.skill_id)::bigint AS unique_skill_count,
                COALESCE(SUM(ce.fulfillment_seconds), 0)::bigint AS fulfillment_sum_seconds,
                COUNT(ce.fulfillment_seconds)::bigint AS fulfillment_sample_size,
                MIN(ce.settled_at) AS first_settled_at,
                MAX(ce.settled_at) AS last_settled_at
           FROM chain_events ce
           LEFT JOIN payment_challenges pc
                  ON pc.payment_id = ce.payment_id
                 AND pc.status = 'paid'
          WHERE ce.buyer_agent_id = $1`,
        [buyerAgentId.toString()],
      );
      const row = result.rows[0];
      return {
        transactionCount: Number(row.transaction_count),
        totalSpentAtomic: BigInt(row.total_spent_atomic),
        totalRefundedAtomic: BigInt(row.total_refunded_atomic),
        refundCount: Number(row.refund_count),
        completedCount: Number(row.completed_count),
        failedCount: Number(row.failed_count),
        canceledCount: Number(row.canceled_count),
        confirmedCount: Number(row.confirmed_count),
        notConfirmedCount: Number(row.not_confirmed_count),
        uniqueProviderCount: Number(row.unique_provider_count),
        uniqueSkillCount: Number(row.unique_skill_count),
        fulfillmentSumSeconds: Number(row.fulfillment_sum_seconds),
        fulfillmentSampleSize: Number(row.fulfillment_sample_size),
        firstSettledAt: row.first_settled_at,
        lastSettledAt: row.last_settled_at,
      };
    },

    async listBuyersByVolume(limit: number): Promise<BuyerVolumeRow[]> {
      const result = await pool.query<{
        agent_id: string;
        transaction_count: string;
        total_spent_atomic: string;
        last_settled_at: Date;
        resolved_name: string | null;
      }>(
        `SELECT ce.buyer_agent_id AS agent_id,
                COUNT(*)::bigint AS transaction_count,
                COALESCE(SUM(ce.amount_atomic), 0)::numeric AS total_spent_atomic,
                MAX(ce.settled_at) AS last_settled_at,
                bi.resolved_name
           FROM chain_events ce
           LEFT JOIN buyer_identities bi ON bi.agent_id = ce.buyer_agent_id
          GROUP BY ce.buyer_agent_id, bi.resolved_name
          ORDER BY total_spent_atomic DESC,
                   transaction_count DESC,
                   ce.buyer_agent_id ASC
          LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        agentId: BigInt(row.agent_id),
        transactionCount: Number(row.transaction_count),
        totalSpentAtomic: BigInt(row.total_spent_atomic),
        lastSettledAt: row.last_settled_at,
        resolvedName: row.resolved_name,
      }));
    },
  };
}
