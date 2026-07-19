import type { Router } from "express";
import type { Hex } from "../types.js";
import {
  formatChainActivityRow,
  formatServiceForPublic,
  formatServicesForPublic,
  type PublicService,
} from "./format.js";
import { mapWithLimit, serviceNotFound } from "./routeHelpers.js";
import type { PublicRouteContext } from "./context.js";

const RECENT_LIMIT = 10;
const NAME_CONCURRENCY = 8;

export function registerServiceRoutes(
  router: Router,
  context: PublicRouteContext,
): void {
  const { config, cache, queries } = context;
  router.get("/public/v1/services", (_req, res) => {
    const services: PublicService[] = cache
      .getAll()
      .flatMap((provider) => formatServicesForPublic(provider, config));
    res.json({
      services,
      cachedAt: cache.getLastRefresh()?.toISOString() ?? null,
    });
  });

  router.get("/public/v1/services/:agentId", async (req, res) => {
    let agentId: bigint;
    try {
      agentId = BigInt(String(req.params.agentId));
    } catch {
      serviceNotFound(res);
      return;
    }
    const provider = cache.get(agentId);
    if (!provider) {
      serviceNotFound(res);
      return;
    }
    const serviceSlug =
      typeof req.query.service === "string" && req.query.service
        ? req.query.service
        : null;
    const service = formatServiceForPublic(provider, config, serviceSlug);
    if (!service) {
      serviceNotFound(res);
      return;
    }

    const [recent, reputation, serviceReputation, aggregates] =
      await Promise.all([
        service.serviceId
          ? queries.listRecentChainActivityByServiceId(
              service.serviceId as Hex,
              RECENT_LIMIT,
            )
          : queries.listRecentChainActivityByProvider(agentId, RECENT_LIMIT),
        context.reputationCache.get(agentId),
        service.serviceId
          ? context.serviceReputationCache.get(service.serviceId)
          : Promise.resolve(null),
        service.serviceId
          ? context.serviceAggregatesCache.get(service.serviceId)
          : Promise.resolve(null),
      ]);
    const buyerNames = await mapWithLimit(
      recent,
      NAME_CONCURRENCY,
      (row) => context.buyerIdentityCache.getName(row.buyerAgentId),
    );
    const recentPurchases = recent.map((row, index) =>
      formatChainActivityRow(
        row,
        service.name,
        service.name,
        buyerNames[index] ?? null,
      ),
    );
    const mergedServiceReputation =
      serviceReputation && aggregates
        ? {
            ...serviceReputation,
            averageFulfillmentSeconds:
              aggregates.fulfillment.averageFulfillmentSeconds,
            fulfillmentSampleSize: aggregates.fulfillment.sampleSize,
            buyerSatisfactionRateByValue:
              aggregates.weightedSatisfaction.rateByValue,
            buyerSatisfactionRateByValueSampleSize:
              aggregates.weightedSatisfaction.sampleSize,
          }
        : serviceReputation;
    const skillNames = new Map(
      service.skills
        .filter((skill) => skill.name)
        .map((skill) => [skill.id, skill.name!]),
    );
    res.json({
      ...service,
      recentPurchases,
      reputation,
      serviceReputation: mergedServiceReputation,
      skillStats: (aggregates?.skillStats ?? []).map((stats) => ({
        ...stats,
        skillName: skillNames.get(stats.skillId) ?? null,
      })),
    });
  });
}
