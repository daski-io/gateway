import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type Hex,
} from "viem";
import { reputationStorageAbi } from "../marketplace/abis.js";
import type { StandardRailConfig } from "./config.js";

interface ReputationCounters {
  completed: bigint;
  failed: bigint;
  canceled: bigint;
  confirmed: bigint;
  notConfirmed: bigint;
  transactions: bigint;
  totalPaid: bigint;
  totalRefunded: bigint;
  confirmedWeight: bigint;
  notConfirmedWeight: bigint;
  outcomeDelayTotal?: bigint;
}

interface ReputationSnapshot {
  providers: Map<string, ReturnType<typeof presentReputation>>;
  services: Map<Hex, ReturnType<typeof presentReputation>>;
  finalizedBlock: string;
}

const CACHE_MILLISECONDS = 30_000;

function rate(numerator: bigint, denominator: bigint): number | null {
  return denominator === 0n ? null : Number(numerator * 10_000n / denominator) / 100;
}

export function presentReputation(counters: ReputationCounters, finalizedBlock: bigint) {
  const completionSamples = counters.completed + counters.failed + counters.canceled;
  const confirmationSamples = counters.confirmed + counters.notConfirmed;
  const weightSamples = counters.confirmedWeight + counters.notConfirmedWeight;
  const hasFulfillmentTiming = counters.outcomeDelayTotal !== undefined && completionSamples > 0n;
  return {
    transactionCount: counters.transactions.toString(),
    completedCount: counters.completed.toString(),
    failedCount: counters.failed.toString(),
    canceledCount: counters.canceled.toString(),
    completionSampleSize: completionSamples.toString(),
    completionRate: rate(counters.completed, completionSamples),
    confirmedCount: counters.confirmed.toString(),
    notConfirmedCount: counters.notConfirmed.toString(),
    confirmationSampleSize: confirmationSamples.toString(),
    buyerSatisfactionRate: rate(counters.confirmed, confirmationSamples),
    valueWeightedBuyerSatisfactionRate: rate(counters.confirmedWeight, weightSamples),
    totalPaid: counters.totalPaid.toString(),
    totalRefunded: counters.totalRefunded.toString(),
    averageFulfillmentSeconds: hasFulfillmentTiming
      ? Number(counters.outcomeDelayTotal! / completionSamples)
      : null,
    fulfillmentSampleSize: hasFulfillmentTiming ? completionSamples.toString() : "0",
    recentPurchases: [],
    finalizedBlock: finalizedBlock.toString(),
  };
}

export class DirectReputationReader {
  private readonly client;
  private cached: { key: string; expiresAt: number; value: ReputationSnapshot } | null = null;
  private loading: { key: string; promise: Promise<ReputationSnapshot> } | null = null;

  constructor(private readonly config: StandardRailConfig, chain: Chain) {
    this.client = createPublicClient({
      chain,
      transport: fallback(config.evidenceRpcUrls.map((url) => http(url, {
        retryCount: 0,
        timeout: 20_000,
      }))),
    });
  }

  async forOutcomes(outcomes: Array<Record<string, unknown>>): Promise<ReputationSnapshot> {
    const key = outcomes.map((item) => `${item.providerAgentId}:${item.serviceId}`).sort().join("|");
    if (this.cached?.key === key && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (this.loading?.key === key) return this.loading.promise;
    const promise = this.readOutcomes(outcomes);
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

  private async readOutcomes(outcomes: Array<Record<string, unknown>>): Promise<ReputationSnapshot> {
    const block = await this.client.getBlock({ blockTag: "finalized" });
    const providerIds = [...new Set(outcomes.map((item) => String(item.providerAgentId)))];
    const serviceIds = [...new Set(outcomes.map((item) => item.serviceId as Hex))];
    const [providerRows, serviceRows] = await Promise.all([
      Promise.all(providerIds.map(async (providerAgentId) => {
        const id = BigInt(providerAgentId);
        const [stats, totalPaid, totalRefunded, outcomeDelayTotal,
          confirmedWeight, notConfirmedWeight] = await Promise.all([
          this.client.readContract({
          address: this.config.reputationContract,
          abi: reputationStorageAbi,
          functionName: "getProviderStats",
          args: [id],
          blockNumber: block.number,
          }),
          ...(["totalPaidByProvider", "refundedAmountByProvider", "outcomeDelayTotalByProvider",
            "confirmedWeightByProvider", "notConfirmedWeightByProvider"] as const).map((functionName) =>
            this.client.readContract({
              address: this.config.reputationContract,
              abi: reputationStorageAbi,
              functionName,
              args: [id],
              blockNumber: block.number,
            })
          ),
        ]);
        return [providerAgentId, presentReputation({
          completed: stats[0], failed: stats[1], canceled: stats[2], confirmed: stats[3],
          notConfirmed: stats[4], transactions: stats[5], totalPaid, totalRefunded,
          outcomeDelayTotal, confirmedWeight, notConfirmedWeight,
        }, block.number)] as const;
      })),
      Promise.all(serviceIds.map(async (serviceId) => {
        const [stats, totalPaid, confirmedWeight, notConfirmedWeight] = await Promise.all([
          this.client.readContract({
          address: this.config.reputationContract,
          abi: reputationStorageAbi,
          functionName: "getServiceStats",
          args: [serviceId],
          blockNumber: block.number,
          }),
          ...(["totalPaidByService", "confirmedWeightByService", "notConfirmedWeightByService"] as const)
            .map((functionName) => this.client.readContract({
              address: this.config.reputationContract,
              abi: reputationStorageAbi,
              functionName,
              args: [serviceId],
              blockNumber: block.number,
            })),
        ]);
        return [serviceId, presentReputation({
          completed: stats[0], failed: stats[1], canceled: stats[2], confirmed: stats[3],
          notConfirmed: stats[4], totalRefunded: stats[5], transactions: stats[6],
          totalPaid, confirmedWeight, notConfirmedWeight,
        }, block.number)] as const;
      })),
    ]);
    const providers = new Map(providerRows);
    const services = new Map<Hex, ReturnType<typeof presentReputation>>(serviceRows);
    return { providers, services, finalizedBlock: block.number.toString() };
  }
}
