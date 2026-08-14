import type { Pool } from "../db/pool.js";

interface AggregateRow {
  provider_agent_id: string;
  outcome_id: string;
  service_id: string;
  transactions: string;
  completed: string;
  failed: string;
  canceled: string;
  confirmed: string;
  not_confirmed: string;
  confirmed_weight: string;
  not_confirmed_weight: string;
  total_paid: string;
  total_refunded: string;
  average_fulfillment_seconds: string | null;
  fulfillment_sample_size: string;
  finalized_block: string | null;
}

interface RecentPurchaseRow {
  provider_agent_id: string;
  outcome_id: string;
  gross_amount: string;
  created_at: Date;
}

export interface StandardRecentPurchase {
  amount: string;
  timestamp: string;
}

export interface StandardReputationPresentation {
  transactionCount: string;
  completedCount: string;
  failedCount: string;
  canceledCount: string;
  completionSampleSize: string;
  completionRate: number | null;
  confirmedCount: string;
  notConfirmedCount: string;
  confirmationSampleSize: string;
  buyerSatisfactionRate: number | null;
  valueWeightedBuyerSatisfactionRate: number | null;
  totalPaid: string;
  totalRefunded: string;
  averageFulfillmentSeconds: number | null;
  fulfillmentSampleSize: string;
  recentPurchases: StandardRecentPurchase[];
  finalizedBlock: string | null;
}

const empty = (finalizedBlock: string | null = null): StandardReputationPresentation => ({
  transactionCount: "0", completedCount: "0", failedCount: "0", canceledCount: "0",
  completionSampleSize: "0", completionRate: null, confirmedCount: "0", notConfirmedCount: "0",
  confirmationSampleSize: "0", buyerSatisfactionRate: null,
  valueWeightedBuyerSatisfactionRate: null, totalPaid: "0", totalRefunded: "0",
  averageFulfillmentSeconds: null, fulfillmentSampleSize: "0", recentPurchases: [],
  finalizedBlock,
});

function ratio(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  return Number((numerator * 10_000n) / denominator) / 100;
}

function presentation(
  row: AggregateRow | undefined,
  recentPurchases: StandardRecentPurchase[] = [],
): StandardReputationPresentation {
  if (!row) return empty();
  const completed = BigInt(row.completed);
  const failed = BigInt(row.failed);
  const canceled = BigInt(row.canceled);
  const confirmed = BigInt(row.confirmed);
  const notConfirmed = BigInt(row.not_confirmed);
  const confirmedWeight = BigInt(row.confirmed_weight);
  const notConfirmedWeight = BigInt(row.not_confirmed_weight);
  return {
    transactionCount: row.transactions,
    completedCount: row.completed,
    failedCount: row.failed,
    canceledCount: row.canceled,
    completionSampleSize: (completed + failed + canceled).toString(),
    completionRate: ratio(completed, completed + failed + canceled),
    confirmedCount: row.confirmed,
    notConfirmedCount: row.not_confirmed,
    confirmationSampleSize: (confirmed + notConfirmed).toString(),
    buyerSatisfactionRate: ratio(confirmed, confirmed + notConfirmed),
    valueWeightedBuyerSatisfactionRate: ratio(
      confirmedWeight,
      confirmedWeight + notConfirmedWeight,
    ),
    totalPaid: row.total_paid,
    totalRefunded: row.total_refunded,
    averageFulfillmentSeconds: row.average_fulfillment_seconds === null
      ? null
      : Number(row.average_fulfillment_seconds),
    fulfillmentSampleSize: row.fulfillment_sample_size,
    recentPurchases,
    finalizedBlock: row.finalized_block,
  };
}

export class StandardReputationProjection {
  constructor(private readonly pool: Pool) {}

  async finalizedBlock(): Promise<string | null> {
    const result = await this.pool.query<{ last_indexed_block: string }>(
      "SELECT last_indexed_block::text FROM standard_reputation_projection_state WHERE singleton=true",
    );
    return result.rows[0]?.last_indexed_block ?? null;
  }

  async outcomes(): Promise<Map<string, StandardReputationPresentation>> {
    const result = await this.query("p.provider_agent_id,o.outcome_id,'0x'||encode(p.service_id,'hex') AS service_id",
      "p.provider_agent_id,o.outcome_id,p.service_id");
    const recent = await this.pool.query<RecentPurchaseRow>(
      `SELECT provider_agent_id,outcome_id,gross_amount::text,created_at
         FROM (
           SELECT p.provider_agent_id,o.outcome_id,p.gross_amount,o.created_at,
                  row_number() OVER (
                    PARTITION BY p.provider_agent_id,o.outcome_id
                    ORDER BY o.created_at DESC,o.order_id DESC
                  ) AS position
             FROM standard_reputation_projection_records p
             JOIN standard_orders o ON o.order_key=p.order_key
            WHERE p.reputation_eligible
         ) purchases
        WHERE position <= 5`,
    );
    const byOutcome = new Map<string, StandardRecentPurchase[]>();
    for (const row of recent.rows) {
      const key = `${row.provider_agent_id}:${row.outcome_id}`;
      const purchases = byOutcome.get(key) ?? [];
      purchases.push({ amount: row.gross_amount, timestamp: row.created_at.toISOString() });
      byOutcome.set(key, purchases);
    }
    return new Map(result.map((row) => {
      const key = `${row.provider_agent_id}:${row.outcome_id}`;
      return [key, presentation(row, byOutcome.get(key))];
    }));
  }

  async provider(providerAgentId: string): Promise<StandardReputationPresentation> {
    const rows = await this.query("p.provider_agent_id,'*' AS outcome_id,'*' AS service_id", "p.provider_agent_id", [providerAgentId]);
    return rows[0] ? presentation(rows[0]) : empty(await this.finalizedBlock());
  }

  async providers(): Promise<Map<string, StandardReputationPresentation>> {
    const rows = await this.query(
      "p.provider_agent_id,'*' AS outcome_id,'*' AS service_id",
      "p.provider_agent_id",
    );
    return new Map(rows.map((row) => [row.provider_agent_id, presentation(row)]));
  }

  async services(): Promise<Map<string, StandardReputationPresentation>> {
    const serviceExpression = "p.service_id";
    const rows = await this.query(
      `'*' AS provider_agent_id,'*' AS outcome_id,'0x'||encode(${serviceExpression},'hex') AS service_id`,
      serviceExpression,
    );
    return new Map(rows.map((row) => [row.service_id, presentation(row)]));
  }

  private async query(selectKeys: string, groupKeys: string, provider?: [string]): Promise<AggregateRow[]> {
    const result = await this.pool.query<AggregateRow>(
      `SELECT ${selectKeys},
          count(*)::text AS transactions,
          count(*) FILTER (WHERE p.outcome=0)::text AS completed,
          count(*) FILTER (WHERE p.outcome=1)::text AS failed,
          count(*) FILTER (WHERE p.outcome=2)::text AS canceled,
          count(*) FILTER (WHERE p.confirmation=1)::text AS confirmed,
          count(*) FILTER (WHERE p.confirmation=2)::text AS not_confirmed,
          COALESCE(sum((floor(ln(greatest(p.gross_amount,250000)::numeric/250000)/ln(2))+1))
            FILTER (WHERE p.confirmation=1),0)::text AS confirmed_weight,
          COALESCE(sum((floor(ln(greatest(p.gross_amount,250000)::numeric/250000)/ln(2))+1))
            FILTER (WHERE p.confirmation=2),0)::text AS not_confirmed_weight,
          COALESCE(sum(p.gross_amount),0)::text AS total_paid,
          COALESCE(sum(p.cumulative_refunded),0)::text AS total_refunded,
          round(avg(p.outcome_attestation_delay) FILTER (WHERE p.outcome=0))::text
            AS average_fulfillment_seconds,
          count(*) FILTER (WHERE p.outcome=0)::text AS fulfillment_sample_size,
          state.last_indexed_block::text AS finalized_block
        FROM standard_reputation_projection_records p
        JOIN standard_orders o ON o.order_key=p.order_key
        CROSS JOIN standard_reputation_projection_state state
       WHERE p.reputation_eligible ${provider ? "AND p.provider_agent_id=$1" : ""}
       GROUP BY ${groupKeys},state.last_indexed_block`,
      provider ?? [],
    );
    return result.rows;
  }
}
