import type { Router } from "express";
import { extractAgentCardName } from "../discovery/format.js";
import {
  formatChainActivityRow,
  formatServicesForPublic,
} from "./format.js";
import {
  buildServiceNameResolver,
  mapWithLimit,
  parseLimit,
} from "./routeHelpers.js";
import type { PublicRouteContext } from "./context.js";

const NAME_CONCURRENCY = 8;

export function registerActivityRoutes(
  router: Router,
  context: PublicRouteContext,
): void {
  const { config, cache, queries } = context;
  router.get("/public/v1/activity", async (req, res) => {
    const rows = await queries.listRecentChainActivity(
      parseLimit(req.query.limit, 50, 200),
    );
    const providerNames = new Map(
      cache
        .getAll()
        .map((provider) => [
          provider.agentId.toString(),
          extractAgentCardName(provider.agentCard),
        ]),
    );
    const serviceName = buildServiceNameResolver(cache, config);
    const buyerNames = await mapWithLimit(
      rows,
      NAME_CONCURRENCY,
      (row) => context.buyerIdentityCache.getName(row.buyerAgentId),
    );
    res.json({
      activity: rows.map((row, index) =>
        formatChainActivityRow(
          row,
          providerNames.get(row.providerAgentId.toString()) ?? null,
          serviceName(
            row.providerAgentId,
            row.serviceId,
            row.serviceSlug,
          ),
          buyerNames[index] ?? null,
        ),
      ),
    });
  });

  router.get("/public/v1/stats", async (_req, res) => {
    const [blockNumber, aggregate] = await Promise.all([
      context.blockCache.get(),
      queries.getPaidAggregate(),
    ]);
    const providers = cache.getAll();
    const serviceCount = providers.reduce(
      (count, provider) =>
        count + formatServicesForPublic(provider, config).length,
      0,
    );
    res.json({
      chain: {
        chainId: config.chainId,
        network: config.network,
        blockNumber: blockNumber.toString(),
      },
      marketplace: {
        providerCount: providers.length,
        serviceCount,
        paidCount: aggregate.count,
        totalVolumeUsdc: (
          Number(aggregate.totalAtomic) / 1_000_000
        ).toFixed(2),
      },
      contracts: {
        paymentRouter: config.paymentRouterAddress,
        providerRegistry: config.providerRegistryAddress,
        serviceRegistry: config.serviceRegistryAddress,
        identityRegistry: config.identityRegistryAddress,
        agentIndex: config.agentIndexAddress,
        x402Adapter: config.x402AdapterAddress,
        permitAdapter: config.permitAdapterAddress ?? null,
        approvalAdapter: config.approvalAdapterAddress ?? null,
        reputationStorage: config.reputationStorageAddress ?? null,
        usdc: config.usdcAddress,
      },
    });
  });
}
