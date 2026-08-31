import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Chain,
} from "viem";
import type { Pool } from "../db/pool.js";
import { withRpcFailover } from "../rpc/failover.js";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardWalletStore } from "./walletStore.js";
import type { WalletAuthorizationTransport } from "./types.js";

interface OrderHistoryRow {
  order_id: string;
  order_handle: string;
  intent_id: string;
  order_key: Buffer;
  provider_agent_id: string;
  outcome_id: string;
  state: string;
  gross_amount: string;
  canonical_listing: { commitment: { payload: { serviceId: string } } };
  registration_operation_state: string | null;
  created_at: Date;
  created_at_cursor: string;
  updated_at: Date;
}

const reputationAbi = parseAbi([
  "function getRecord(bytes32 orderKey) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationTransitions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
  "function getBuyerStats(address payer) view returns (uint256,uint256,uint256)",
  "function totalPaidByPayer(address payer) view returns (uint256)",
  "function refundedAmountByPayer(address payer) view returns (uint256)",
]);

const ZERO_HASH = `0x${"00".repeat(32)}`;

export class StandardWalletQueries {
  private readonly clients;

  constructor(
    private readonly pool: Pool,
    private readonly wallet: StandardWalletStore,
    config: StandardRailConfig,
    chain: Chain,
  ) {
    this.clients = config.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: http(url, { retryCount: 0, timeout: 20_000 }),
      }),
    }));
    this.reputationContract = config.reputationContract;
  }

  private readonly reputationContract: Address;

  private observe<Result>(
    work: (endpoint: (typeof this.clients)[number]) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("standard wallet RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
  }

  async listOrders(args: {
    payer: string;
    limit: number;
    cursor: string | null;
    paymentIdentifier?: string | null;
    authorization: WalletAuthorizationTransport;
  }) {
    const request = {
      limit: args.limit,
      cursor: args.cursor,
      ...(args.paymentIdentifier ? { paymentIdentifier: args.paymentIdentifier } : {}),
    };
    // Only the payer proven by the signed authorization may be queried.
    const { payer } = await this.wallet.consume({
      payer: args.payer, authorization: args.authorization, action: "list-orders", request,
    });
    const binding = this.wallet.orderCursorBinding(payer, args.limit, args.paymentIdentifier ?? null);
    const last = args.cursor ? this.wallet.decodeOrderCursor(args.cursor, binding) : null;
    const result = await this.pool.query<OrderHistoryRow>(
      `SELECT o.order_id,o.order_handle,o.intent_id,o.order_key,o.provider_agent_id,o.outcome_id,
              o.state,o.gross_amount,o.canonical_listing,o.created_at,
              o.created_at::text AS created_at_cursor,o.updated_at,
              r.state AS registration_operation_state
         FROM standard_orders o
         LEFT JOIN standard_reputation_operations r
           ON r.order_id=o.order_id AND r.kind='register'
        WHERE lower(o.payer)=$1
          AND ($2::timestamptz IS NULL OR (o.created_at,o.order_id)<($2::timestamptz,$3))
          AND ($4::text IS NULL OR o.intent_id=$4)
        ORDER BY o.created_at DESC,o.order_id DESC
        LIMIT $5`,
      [
        payer,
        last?.createdAt ?? null,
        last?.id ?? null,
        args.paymentIdentifier ?? null,
        args.limit + 1,
      ],
    );
    const rows = result.rows.slice(0, args.limit);
    const hasMore = result.rows.length > args.limit;
    const records = await this.observe(async ({ client }) => {
      const block = await client.getBlock({ blockTag: "finalized" });
      return Promise.all(rows.map((row) => client.readContract({
        address: this.reputationContract,
        abi: reputationAbi,
        functionName: "getRecord",
        args: [`0x${row.order_key.toString("hex")}`],
        blockNumber: block.number,
      })));
    });
    return {
      orders: rows.map((row, index) => {
        const reputation = records[index]!;
        const registered = reputation.orderKey !== ZERO_HASH;
        return ({
        orderHandle: row.order_handle,
        paymentIdentifier: row.intent_id,
        orderKey: `0x${row.order_key.toString("hex")}`,
        providerAgentId: row.provider_agent_id,
        serviceId: row.canonical_listing.commitment.payload.serviceId,
        outcomeId: row.outcome_id,
        state: row.state,
        grossAmount: row.gross_amount,
        reputation: {
          registrationState: registered
            ? reputation.reputationEligible ? "final" : "unavailable"
            : reputationState(row.registration_operation_state),
          providerOutcome: registered
            ? providerOutcome(reputation.outcome, reputation.outcomeRecorded)
            : "Pending",
          buyerConfirmation: registered ? confirmation(reputation.confirmation) : "Pending",
          confirmationTransitionsUsed: registered ? reputation.confirmationTransitions : 0,
        },
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }); }),
      nextCursor: hasMore && rows.length > 0
        ? this.wallet.encodeOrderCursor({
            createdAt: rows.at(-1)!.created_at_cursor,
            id: rows.at(-1)!.order_id,
          }, binding)
        : null,
    };
  }

  async getReputation(args: {
    payer: string;
    authorization: WalletAuthorizationTransport;
  }) {
    const request = {};
    // Only the payer proven by the signed authorization may be queried.
    const { payer } = await this.wallet.consume({
      payer: args.payer,
      authorization: args.authorization,
      action: "get-buyer-reputation",
      request,
    });
    const address = getAddress(payer);
    return this.observe(async ({ client }) => {
      const block = await client.getBlock({ blockTag: "safe" });
      const [[eligible, confirmed, notConfirmed], totalPaid, totalRefunded] = await Promise.all([
        client.readContract({
          address: this.reputationContract,
          abi: reputationAbi,
          functionName: "getBuyerStats",
          args: [address],
          blockNumber: block.number,
        }),
        client.readContract({
          address: this.reputationContract,
          abi: reputationAbi,
          functionName: "totalPaidByPayer",
          args: [address],
          blockNumber: block.number,
        }),
        client.readContract({
          address: this.reputationContract,
          abi: reputationAbi,
          functionName: "refundedAmountByPayer",
          args: [address],
          blockNumber: block.number,
        }),
      ]);
      return {
        eligibleTransactionCount: eligible.toString(),
        confirmedCount: confirmed.toString(),
        notConfirmedCount: notConfirmed.toString(),
        totalPaid: totalPaid.toString(),
        totalRefunded: totalRefunded.toString(),
        safeBlock: block.number.toString(),
      };
    });
  }
}

function reputationState(state: string | null): string {
  if (state === "final") return "final";
  if (state === "unavailable" || state?.startsWith("aborted")) return "unavailable";
  return "pending";
}

export function providerOutcome(outcome: number | null, recorded: boolean): string {
  if (!recorded) return "Pending";
  if (outcome === 0) return "Completed";
  if (outcome === 1) return "Failed";
  if (outcome === 2) return "Canceled";
  return "Pending";
}

function confirmation(value: number | null): string {
  return value === 1 ? "Confirmed" : value === 2 ? "NotConfirmed" : "Pending";
}
