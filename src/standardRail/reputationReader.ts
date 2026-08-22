import {
  createPublicClient,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
import { withRpcFailover } from "../rpc/failover.js";
import { logger } from "../util/logger.js";
import {
  agentIndexAbi,
  identityRegistryAbi,
  reputationStorageAbi,
} from "../marketplace/abis.js";
import type { StandardRailConfig } from "./config.js";
import {
  presentReputation,
  type ProjectedReputationRecord,
} from "./reputationProjection.js";

interface OutcomeDescriptor {
  providerAgentId: string;
  serviceId: Hex;
  outcomeId: string;
  listingManifestHash: Hex;
}

interface ReputationSnapshot {
  providers: Map<string, ReturnType<typeof presentReputation>>;
  services: Map<Hex, ReturnType<typeof presentReputation>>;
  safeBlock: string;
}

interface SettlementRow {
  order_key: string;
  settlement_tx_hash: string | null;
}

interface BuyerIdentity {
  agentId: string | null;
  name: string | null;
}

// Refreshes stay O(records) even with aggregated reads, so the snapshot is held until
// the reputation worker reports a new on-chain write or the safety TTL lapses.
const CACHE_MILLISECONDS = 300_000;
const MULTICALL_BATCH_BYTES = 8_192;

function inlineAgentName(uri: string): string | null {
  if (!uri.startsWith("data:") || uri.length > 90_000) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  try {
    const metadata = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    const decoded = /;base64(?:;|$)/i.test(metadata)
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    if (Buffer.byteLength(decoded, "utf8") > 65_536) return null;
    const value = JSON.parse(decoded) as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    return name.length > 0 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name)
      ? name
      : null;
  } catch {
    return null;
  }
}

function asOutcome(value: Record<string, unknown>): OutcomeDescriptor {
  return {
    providerAgentId: String(value.providerAgentId),
    serviceId: value.serviceId as Hex,
    outcomeId: String(value.outcomeId),
    listingManifestHash: value.listingManifestHash as Hex,
  };
}

export { presentReputation } from "./reputationProjection.js";

export class DirectReputationReader {
  private readonly clients;
  private cached: { key: string; expiresAt: number; value: ReputationSnapshot } | null = null;
  private loading: { key: string; promise: Promise<ReputationSnapshot> } | null = null;

  constructor(
    private readonly config: StandardRailConfig,
    chain: Chain,
    private readonly pool: Pick<Pool, "query">,
    private readonly addresses: { agentIndex: Address; identityRegistry: Address },
  ) {
    this.clients = config.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: http(url, { retryCount: 0, timeout: 20_000 }),
      }),
    }));
  }

  private observe<Result>(
    work: (endpoint: (typeof this.clients)[number]) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("direct reputation RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
  }

  invalidate(): void {
    this.cached = null;
  }

  async forOutcomes(outcomes: Array<Record<string, unknown>>): Promise<ReputationSnapshot> {
    const descriptors = outcomes.map(asOutcome);
    const key = descriptors.map((item) =>
      `${item.providerAgentId}:${item.serviceId}:${item.listingManifestHash}`
    ).sort().join("|");
    if (this.cached?.key === key && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (this.loading?.key === key) return this.loading.promise;
    const promise = this.readOutcomes(descriptors);
    this.loading = { key, promise };
    try {
      const value = await promise;
      this.cached = { key, expiresAt: Date.now() + CACHE_MILLISECONDS, value };
      return value;
    } catch (error) {
      if (this.cached?.key === key) return this.cached.value;
      throw error;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  private async readOutcomes(outcomes: OutcomeDescriptor[]): Promise<ReputationSnapshot> {
    const { block, chainRows, settlementRows } = await this.observe(async ({ client }) => {
      const block = await client.getBlock({ blockTag: "safe" });
      const count = await client.readContract({
        address: this.config.reputationContract,
        abi: reputationStorageAbi,
        functionName: "getRecordCount",
        blockNumber: block.number,
      });
      if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Public reputation record count exceeds the supported integer range");
      }
      const keys = Number(count) === 0 ? [] : await client.multicall({
        contracts: Array.from({ length: Number(count) }, (_, index) => ({
          address: this.config.reputationContract,
          abi: reputationStorageAbi,
          functionName: "recordKeys",
          args: [BigInt(index)],
        } as const)),
        allowFailure: false,
        batchSize: MULTICALL_BATCH_BYTES,
        blockNumber: block.number,
      });
      const [recordValues, refundValues, settlementRows] = await Promise.all([
        keys.length === 0 ? [] : client.multicall({
          contracts: keys.map((orderKey) => ({
            address: this.config.reputationContract,
            abi: reputationStorageAbi,
            functionName: "getRecord",
            args: [orderKey],
          } as const)),
          allowFailure: false,
          batchSize: MULTICALL_BATCH_BYTES,
          blockNumber: block.number,
        }),
        keys.length === 0 ? [] : client.multicall({
          contracts: keys.map((orderKey) => ({
            address: this.config.reputationContract,
            abi: reputationStorageAbi,
            functionName: "refundedAmount",
            args: [orderKey],
          } as const)),
          allowFailure: false,
          batchSize: MULTICALL_BATCH_BYTES,
          blockNumber: block.number,
        }),
        this.settlementRows(keys),
      ]);
      const chainRows = keys.map((_, index) => ({
        record: recordValues[index]!,
        refundedAmount: refundValues[index]!,
      }));
      return { block, chainRows, settlementRows };
    });
    const settlementByOrder = new Map(settlementRows.map((row) => [
      row.order_key.toLowerCase(),
      /^0x[0-9a-f]{64}$/i.test(row.settlement_tx_hash ?? "")
        ? row.settlement_tx_hash as Hex
        : null,
    ]));
    const eligiblePayers = [...new Set(chainRows
      .filter(({ record }) => record.reputationEligible)
      .map(({ record }) => record.payer.toLowerCase()))] as Address[];
    const buyers = await this.resolveBuyers(eligiblePayers, block.number);
    const byManifest = new Map(outcomes.map((outcome) => [outcome.listingManifestHash.toLowerCase(), outcome]));
    const byService = new Map(outcomes.map((outcome) => [outcome.serviceId.toLowerCase(), outcome]));
    const records: ProjectedReputationRecord[] = chainRows.map(({ record, refundedAmount }) => {
      const outcome = byManifest.get(record.listingManifestHash.toLowerCase()) ??
        byService.get(record.serviceId.toLowerCase());
      const buyer = buyers.get(record.payer.toLowerCase() as Address) ?? { agentId: null, name: null };
      return {
        orderKey: record.orderKey,
        providerAgentId: record.providerAgentId.toString(),
        serviceId: record.serviceId,
        payer: record.payer,
        grossAmount: record.grossAmount,
        paidAt: record.paidAt,
        outcome: record.outcome,
        confirmation: record.confirmation,
        outcomeAttestationDelay: record.outcomeAttestationDelay,
        outcomeRecorded: record.outcomeRecorded,
        reputationEligible: record.reputationEligible,
        refundedAmount,
        settlementTransactionHash: settlementByOrder.get(record.orderKey.toLowerCase()) ?? null,
        buyerAgentId: buyer.agentId,
        buyerName: buyer.name,
        outcomeId: outcome?.outcomeId ?? "unknown",
      };
    });
    const providerIds = [...new Set(outcomes.map((item) => item.providerAgentId))];
    const serviceIds = [...new Set(outcomes.map((item) => item.serviceId))];
    return {
      providers: new Map(providerIds.map((id) => [
        id,
        presentReputation(records.filter((record) => record.providerAgentId === id), block.number),
      ])),
      services: new Map(serviceIds.map((id) => [
        id,
        presentReputation(
          records.filter((record) => record.serviceId.toLowerCase() === id.toLowerCase()),
          block.number,
        ),
      ])),
      safeBlock: block.number.toString(),
    };
  }

  private settlementRows(orderKeys: Hex[]): Promise<SettlementRow[]> {
    if (orderKeys.length === 0) return Promise.resolve([]);
    return this.pool.query<SettlementRow>(
      `SELECT '0x'||encode(order_key,'hex') AS order_key,settlement_tx_hash
         FROM standard_orders
        WHERE encode(order_key,'hex')=ANY($1::text[])`,
      [orderKeys.map((key) => key.slice(2))],
    ).then((result) => result.rows, () => []);
  }

  private async resolveBuyers(
    payers: readonly Address[],
    blockNumber: bigint,
  ): Promise<Map<Address, BuyerIdentity>> {
    const emptyBuyers = new Map<Address, BuyerIdentity>(
      payers.map((payer) => [payer, { agentId: null, name: null }]),
    );
    if (payers.length === 0) return emptyBuyers;
    try {
      return await this.observe(async ({ client }) => {
        const buyers = new Map<Address, BuyerIdentity>(
          payers.map((payer) => [payer, { agentId: null, name: null }]),
        );
        const resolutions = await client.multicall({
          contracts: payers.map((payer) => ({
            address: this.addresses.agentIndex,
            abi: agentIndexAbi,
            functionName: "resolve",
            args: [payer],
          } as const)),
          batchSize: MULTICALL_BATCH_BYTES,
          blockNumber,
        });
        const found: Array<{ payer: Address; agentId: bigint }> = [];
        resolutions.forEach((resolution, index) => {
          if (resolution.status !== "success") return;
          const [agentId, isRegistered] = resolution.result;
          if (isRegistered) found.push({ payer: payers[index]!, agentId });
        });
        if (found.length === 0) return buyers;
        const uris = await client.multicall({
          contracts: found.map(({ agentId }) => ({
            address: this.addresses.identityRegistry,
            abi: identityRegistryAbi,
            functionName: "tokenURI",
            args: [agentId],
          } as const)),
          batchSize: MULTICALL_BATCH_BYTES,
          blockNumber,
        });
        found.forEach(({ payer, agentId }, index) => {
          const uri = uris[index];
          buyers.set(payer, {
            agentId: agentId.toString(),
            name: uri?.status === "success" ? inlineAgentName(uri.result) : null,
          });
        });
        return buyers;
      });
    } catch {
      return emptyBuyers;
    }
  }
}
