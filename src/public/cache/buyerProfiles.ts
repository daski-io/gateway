import type { ChainActivityRow, Queries } from "../../db/queries.js";
import {
  derivePublicBuyerReputation,
  type PublicBuyerReputation,
} from "../format.js";
import { BoundedCache } from "./bounded.js";

export interface BuyerProfileValue {
  reputation: PublicBuyerReputation;
  firstPurchaseAt: Date | null;
  lastPurchaseAt: Date | null;
  recentPurchases: ChainActivityRow[];
}

const EMPTY_PROFILE: BuyerProfileValue = {
  reputation: derivePublicBuyerReputation({
    transactionCount: 0,
    totalSpentAtomic: 0n,
    totalRefundedAtomic: 0n,
    refundCount: 0,
    completedCount: 0,
    failedCount: 0,
    canceledCount: 0,
    confirmedCount: 0,
    notConfirmedCount: 0,
    uniqueProviderCount: 0,
    uniqueSkillCount: 0,
    fulfillmentSumSeconds: 0,
    fulfillmentSampleSize: 0,
  }),
  firstPurchaseAt: null,
  lastPurchaseAt: null,
  recentPurchases: [],
};

export class BuyerProfileCache {
  private readonly entries: BoundedCache<string, BuyerProfileValue>;

  constructor(
    private readonly queries: Queries,
    private readonly recentLimit: number,
    private readonly ttlMs = 60_000,
    maxEntries = 1000,
  ) {
    this.entries = new BoundedCache(maxEntries);
  }

  async get(agentId: bigint): Promise<BuyerProfileValue> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const [aggregate, recentPurchases] = await Promise.all([
        this.queries.aggregateChainActivityByBuyer(agentId),
        this.queries.listRecentChainActivityByBuyer(
          agentId,
          this.recentLimit,
        ),
      ]);
      const value = {
        reputation: derivePublicBuyerReputation(aggregate),
        firstPurchaseAt: aggregate.firstSettledAt,
        lastPurchaseAt: aggregate.lastSettledAt,
        recentPurchases,
      };
      this.entries.set(key, value, now);
      return value;
    } catch {
      return hit?.value ?? EMPTY_PROFILE;
    }
  }
}

export class BuyerLeaderboardCache {
  private readonly entries: BoundedCache<
    number,
    Awaited<ReturnType<Queries["listBuyersByVolume"]>>
  >;

  constructor(
    private readonly queries: Queries,
    private readonly ttlMs = 60_000,
    maxEntries = 100,
  ) {
    this.entries = new BoundedCache(maxEntries);
  }

  async get(limit: number) {
    const now = Date.now();
    const hit = this.entries.get(limit);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const value = await this.queries.listBuyersByVolume(limit);
      this.entries.set(limit, value, now);
      return value;
    } catch {
      return hit?.value ?? [];
    }
  }
}
