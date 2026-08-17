import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
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
  finalizedBlock: string;
}

interface SettlementRow {
  order_key: string;
  settlement_tx_hash: string | null;
}

interface BuyerIdentity {
  agentId: string | null;
  name: string | null;
}

const CACHE_MILLISECONDS = 30_000;

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
  private readonly client;
  private cached: { key: string; expiresAt: number; value: ReputationSnapshot } | null = null;
  private loading: { key: string; promise: Promise<ReputationSnapshot> } | null = null;

  constructor(
    private readonly config: StandardRailConfig,
    chain: Chain,
    private readonly pool: Pick<Pool, "query">,
    private readonly addresses: { agentIndex: Address; identityRegistry: Address },
  ) {
    this.client = createPublicClient({
      chain,
      transport: fallback(config.evidenceRpcUrls.map((url) => http(url, {
        retryCount: 0,
        timeout: 20_000,
      }))),
    });
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
    const block = await this.client.getBlock({ blockTag: "finalized" });
    const count = await this.client.readContract({
      address: this.config.reputationContract,
      abi: reputationStorageAbi,
      functionName: "getRecordCount",
      blockNumber: block.number,
    });
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Public reputation record count exceeds the supported integer range");
    }
    const keys = await Promise.all(Array.from({ length: Number(count) }, (_, index) =>
      this.client.readContract({
        address: this.config.reputationContract,
        abi: reputationStorageAbi,
        functionName: "recordKeys",
        args: [BigInt(index)],
        blockNumber: block.number,
      })
    ));
    const [chainRows, settlementRows] = await Promise.all([
      Promise.all(keys.map(async (orderKey) => {
        const [record, refundedAmount] = await Promise.all([
          this.client.readContract({
            address: this.config.reputationContract,
            abi: reputationStorageAbi,
            functionName: "getRecord",
            args: [orderKey],
            blockNumber: block.number,
          }),
          this.client.readContract({
            address: this.config.reputationContract,
            abi: reputationStorageAbi,
            functionName: "refundedAmount",
            args: [orderKey],
            blockNumber: block.number,
          }),
        ]);
        return { record, refundedAmount };
      })),
      this.settlementRows(keys),
    ]);
    const settlementByOrder = new Map(settlementRows.map((row) => [
      row.order_key.toLowerCase(),
      /^0x[0-9a-f]{64}$/i.test(row.settlement_tx_hash ?? "")
        ? row.settlement_tx_hash as Hex
        : null,
    ]));
    const eligiblePayers = [...new Set(chainRows
      .filter(({ record }) => record.reputationEligible)
      .map(({ record }) => record.payer.toLowerCase()))] as Address[];
    const buyerRows = await Promise.all(eligiblePayers.map(async (payer) => [
      payer,
      await this.resolveBuyer(payer, block.number),
    ] as const));
    const buyers = new Map(buyerRows);
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
      finalizedBlock: block.number.toString(),
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

  private async resolveBuyer(payer: Address, blockNumber: bigint): Promise<BuyerIdentity> {
    try {
      const [agentId, found] = await this.client.readContract({
        address: this.addresses.agentIndex,
        abi: agentIndexAbi,
        functionName: "resolve",
        args: [payer],
        blockNumber,
      });
      if (!found) return { agentId: null, name: null };
      const uri = await this.client.readContract({
        address: this.addresses.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
        blockNumber,
      });
      return { agentId: agentId.toString(), name: inlineAgentName(uri) };
    } catch {
      return { agentId: null, name: null };
    }
  }
}
