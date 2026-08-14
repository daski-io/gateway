import { getAddress } from "viem";
import type { Pool } from "../db/pool.js";
import type { StandardWalletStore } from "./walletStore.js";
import type { WalletAuthorizationTransport } from "./types.js";

interface OrderHistoryRow {
  order_id: string;
  order_handle: string;
  order_key: Buffer;
  provider_agent_id: string;
  outcome_id: string;
  state: string;
  gross_amount: string;
  canonical_listing: { commitment: { payload: { serviceId: string } } };
  registration_state: string | null;
  provider_outcome: number | null;
  confirmation_state: number | null;
  confirmation_transitions: number | null;
  created_at: Date;
  updated_at: Date;
}

export class StandardWalletQueries {
  constructor(
    private readonly pool: Pool,
    private readonly wallet: StandardWalletStore,
  ) {}

  async listOrders(args: {
    payer: string;
    limit: number;
    cursor: string | null;
    authorization: WalletAuthorizationTransport;
  }) {
    const payer = getAddress(args.payer).toLowerCase();
    const request = { payer, limit: args.limit, cursor: args.cursor };
    await this.wallet.consume({ authorization: args.authorization, action: "list-orders", request });
    const binding = this.wallet.orderCursorBinding(payer, args.limit);
    const last = args.cursor ? this.wallet.decodeOrderCursor(args.cursor, binding) : null;
    const result = await this.pool.query<OrderHistoryRow>(
      `SELECT o.order_id,o.order_handle,o.order_key,o.provider_agent_id,o.outcome_id,
              o.state,o.gross_amount,o.canonical_listing,o.created_at,o.updated_at,
              CASE WHEN p.order_key IS NOT NULL AND p.reputation_eligible THEN 'final'
                WHEN p.order_key IS NOT NULL THEN 'unavailable'
                WHEN r.state IN ('aborted_unattested','blocked_parent_aborted') THEN 'unavailable'
                ELSE 'pending' END AS registration_state,
              p.outcome AS provider_outcome,p.confirmation AS confirmation_state,
              p.confirmation_transitions AS confirmation_transitions
         FROM standard_orders o
         LEFT JOIN standard_reputation_operations r
           ON r.order_id=o.order_id AND r.kind='register'
         LEFT JOIN standard_reputation_projection_records p ON p.order_key=o.order_key
        WHERE lower(o.payer)=$1
          AND ($2::timestamptz IS NULL OR (o.created_at,o.order_id)<($2::timestamptz,$3))
        ORDER BY o.created_at DESC,o.order_id DESC
        LIMIT $4`,
      [payer, last?.createdAt ?? null, last?.id ?? null, args.limit + 1],
    );
    const rows = result.rows.slice(0, args.limit);
    const hasMore = result.rows.length > args.limit;
    return {
      orders: rows.map((row) => ({
        orderHandle: row.order_handle,
        orderKey: `0x${row.order_key.toString("hex")}`,
        providerAgentId: row.provider_agent_id,
        serviceId: row.canonical_listing.commitment.payload.serviceId,
        outcomeId: row.outcome_id,
        state: row.state,
        grossAmount: row.gross_amount,
        reputation: {
          registrationState: reputationState(row.registration_state),
          providerOutcome: providerOutcome(row.provider_outcome),
          buyerConfirmation: confirmation(row.confirmation_state),
          confirmationTransitionsUsed: row.confirmation_transitions ?? 0,
        },
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor: hasMore && rows.length > 0
        ? this.wallet.encodeOrderCursor({
            createdAt: rows.at(-1)!.created_at.toISOString(),
            id: rows.at(-1)!.order_id,
          }, binding)
        : null,
    };
  }

  async getReputation(args: {
    payer: string;
    authorization: WalletAuthorizationTransport;
  }) {
    const payer = getAddress(args.payer).toLowerCase();
    const request = { payer };
    await this.wallet.consume({
      authorization: args.authorization,
      action: "get-buyer-reputation",
      request,
    });
    const result = await this.pool.query<{
      eligible_count: string;
      confirmed_count: string;
      not_confirmed_count: string;
      total_paid: string;
      total_refunded: string;
      finalized_block: string | null;
    }>(
      `SELECT count(p.order_key)::text AS eligible_count,
              count(*) FILTER (WHERE p.confirmation=1)::text AS confirmed_count,
              count(*) FILTER (WHERE p.confirmation=2)::text AS not_confirmed_count,
              COALESCE(sum(p.gross_amount),0)::text AS total_paid,
              COALESCE(sum(p.cumulative_refunded),0)::text AS total_refunded,
              state.last_indexed_block::text AS finalized_block
         FROM standard_reputation_projection_state state
         LEFT JOIN standard_reputation_projection_records p
           ON lower(p.payer)=$1 AND p.reputation_eligible
        GROUP BY state.last_indexed_block`,
      [payer],
    );
    const row = result.rows[0]!;
    return {
      eligibleTransactionCount: row.eligible_count,
      confirmedCount: row.confirmed_count,
      notConfirmedCount: row.not_confirmed_count,
      totalPaid: row.total_paid,
      totalRefunded: row.total_refunded,
      finalizedBlock: row.finalized_block,
    };
  }
}

function reputationState(state: string | null): string {
  if (state === "final") return "final";
  if (state === "unavailable" || state?.startsWith("aborted")) return "unavailable";
  return "pending";
}

function providerOutcome(outcome: number | null): string {
  if (outcome === 0) return "Completed";
  if (outcome === 1) return "Failed";
  if (outcome === 2) return "Canceled";
  return "Pending";
}

function confirmation(value: number | null): string {
  return value === 1 ? "Confirmed" : value === 2 ? "NotConfirmed" : "Pending";
}
