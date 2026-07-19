import type { ChainReader } from "../../chain/reader.js";
import type { Queries } from "../../db/queries.js";
import {
  deriveProviderReputation,
  deriveServiceReputation,
  deriveServiceWeightedSatisfaction,
  type PublicServiceLevelReputation,
  type PublicServiceReputation,
} from "../format.js";
import { chainRowToSkillEnriched } from "./serviceAggregates.js";
import type { Hex } from "../../types.js";

export class BlockNumberCache {
  private value = 0n;
  private fetchedAt = 0;

  constructor(
    private readonly reader: ChainReader,
    private readonly ttlMs = 2000,
  ) {}

  async get(): Promise<bigint> {
    const now = Date.now();
    if (this.fetchedAt > 0 && now - this.fetchedAt < this.ttlMs) {
      return this.value;
    }
    try {
      this.value = await this.reader.getBlockNumber();
      this.fetchedAt = now;
    } catch {
      // A stale block height is preferable to failing the public stats API.
    }
    return this.value;
  }
}

export class ProviderReputationCache {
  private readonly entries = new Map<
    string,
    { value: PublicServiceReputation | null; fetchedAt: number }
  >();

  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly sampleLimit: number,
    private readonly ttlMs = 30_000,
  ) {}

  async get(agentId: bigint): Promise<PublicServiceReputation | null> {
    const key = agentId.toString();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const [raw, spend, rows] = await Promise.all([
        this.reader.getProviderReputation(agentId),
        this.queries.getProviderSpend(agentId),
        this.queries.listRecentChainActivityByProvider(
          agentId,
          this.sampleLimit,
        ),
      ]);
      const value = raw
        ? deriveProviderReputation(
            raw,
            spend.totalAtomic,
            deriveServiceWeightedSatisfaction(
              rows.map(chainRowToSkillEnriched),
            ),
          )
        : null;
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? null;
    }
  }
}

export class ServiceReputationCache {
  private readonly entries = new Map<
    string,
    { value: PublicServiceLevelReputation | null; fetchedAt: number }
  >();

  constructor(
    private readonly reader: ChainReader,
    private readonly queries: Queries,
    private readonly ttlMs = 30_000,
  ) {}

  async get(serviceId: Hex): Promise<PublicServiceLevelReputation | null> {
    const key = serviceId.toLowerCase();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.fetchedAt < this.ttlMs) return hit.value;
    try {
      const [raw, spend] = await Promise.all([
        this.reader.getServiceReputation(serviceId),
        this.queries.getServiceSpend(serviceId),
      ]);
      const value = raw
        ? deriveServiceReputation(raw, serviceId, undefined, spend.totalAtomic)
        : null;
      this.entries.set(key, { value, fetchedAt: now });
      return value;
    } catch {
      return hit?.value ?? null;
    }
  }
}
