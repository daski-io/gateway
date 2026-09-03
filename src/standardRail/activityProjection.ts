import type { Hex } from "viem";
import type {
  PublicChainMetadataV3,
  PublicMarketplacePurchaseV1,
  PublicOutcomeV1,
} from "./types.js";

export interface ActivityRowV1 extends PublicMarketplacePurchaseV1 {
  serviceId: Hex;
  serviceName: string;
  skillName: string;
}

export interface ActivityProjectionV1 {
  generatedAt: string;
  network: string;
  chainId: number;
  contracts: PublicChainMetadataV3["contracts"];
  safeBlock: string | null;
  serviceCount: number;
  totalPaid: string;
  transactionCount: string;
  purchases: ActivityRowV1[];
}

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

/**
 * The rows the marketplace activity page renders, derived the way the
 * website derives them from the chain document: one serviceReputation block
 * per distinct service, each purchase joined back to its outcome for the
 * service and skill names, newest first.
 */
export function activityProjection(args: {
  outcomes: readonly PublicOutcomeV1[];
  network: string;
  chainId: number;
  contracts: PublicChainMetadataV3["contracts"];
  generatedAt: Date;
  limit: number;
}): ActivityProjectionV1 {
  const services = [...new Map(args.outcomes.map((outcome) => [
    outcome.serviceId.toLowerCase(),
    outcome,
  ])).values()];
  const outcomesById = new Map(args.outcomes.map((outcome) => [
    `${outcome.providerAgentId}:${outcome.outcomeId}`,
    outcome,
  ]));
  const safeBlock = services
    .map((outcome) => outcome.serviceReputation.safeBlock)
    .filter((value): value is string => value !== null)
    .map(BigInt)
    .reduce<bigint | null>(
      (latest, block) => latest === null || block > latest ? block : latest,
      null,
    );
  const purchases = services
    .flatMap((service) => service.serviceReputation.recentPurchases.map((purchase) => {
      const outcome = outcomesById.get(`${service.providerAgentId}:${purchase.outcomeId}`) ??
        service;
      return {
        ...purchase,
        serviceId: outcome.serviceId,
        serviceName: outcome.service.name,
        skillName: outcome.skill.name,
      };
    }))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, args.limit);
  return {
    generatedAt: args.generatedAt.toISOString(),
    network: args.network,
    chainId: args.chainId,
    contracts: args.contracts,
    safeBlock: safeBlock?.toString() ?? null,
    serviceCount: services.length,
    totalPaid: sum(services.map((outcome) => outcome.serviceReputation.totalPaid)),
    transactionCount: sum(services.map((outcome) => outcome.serviceReputation.transactionCount)),
    purchases,
  };
}

/** Parses `?limit=`: absent means the default, anything else must be 1 to 200. */
export function activityLimit(raw: unknown): number | null {
  if (raw === undefined) return ACTIVITY_DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= ACTIVITY_MAX_LIMIT ? value : null;
}
