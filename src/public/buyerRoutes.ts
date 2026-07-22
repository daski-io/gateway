import type { Router } from "express";
import { cardsOf, extractAgentCardName } from "../discovery/agentCard.js";
import {
  formatChainActivityRow,
  type PublicBuyerDetail,
  type PublicBuyerSummary,
} from "./format.js";
import { buildServiceNameResolver, mapWithLimit, parseLimit } from "./routeHelpers.js";
import type { PublicRouteContext } from "./context.js";
import { sanitizeBuyerName } from "../identity/name.js";

const NAME_CONCURRENCY = 8;

export function registerBuyerRoutes(router: Router, context: PublicRouteContext): void {
  const { cache, config } = context;
  router.get("/public/v1/buyers", async (req, res) => {
    const rows = await context.buyerLeaderboardCache.get(parseLimit(req.query.limit, 25, 100));
    const names = await mapWithLimit(rows, NAME_CONCURRENCY, (row) => {
      const storedName = sanitizeBuyerName(row.resolvedName);
      return storedName.ok
        ? Promise.resolve(storedName.name)
        : context.buyerIdentityCache.getName(row.agentId);
    });
    const buyers: PublicBuyerSummary[] = rows.map((row, index) => ({
      agentId: row.agentId.toString(),
      name: names[index] ?? null,
      totalSpentUsdc: (Number(row.totalSpentAtomic) / 1_000_000).toFixed(2),
      transactionCount: row.transactionCount,
      lastPurchaseAt: row.lastSettledAt.toISOString(),
    }));
    res.json({ buyers });
  });

  router.get("/public/v1/buyers/:agentId", async (req, res) => {
    let agentId: bigint;
    try {
      agentId = BigInt(String(req.params.agentId));
    } catch {
      res.status(404).json({
        error: { code: "BUYER_NOT_FOUND", message: "unknown buyer" },
      });
      return;
    }
    const identity = await context.buyerIdentityCache.get(agentId);
    if (!identity && !(await context.queries.buyerHasChainActivity(agentId))) {
      res.status(404).json({
        error: { code: "BUYER_NOT_FOUND", message: "unknown buyer" },
      });
      return;
    }
    const profile = await context.buyerProfileCache.get(agentId);
    const serviceName = buildServiceNameResolver(cache, config);
    const recentPurchases = profile.recentPurchases.map((row) => {
      const provider = cache.get(row.providerAgentId);
      return formatChainActivityRow(
        row,
        provider?.cards.length ? extractAgentCardName(cardsOf(provider)[0]!.agentCard) : null,
        serviceName(row.providerAgentId, row.serviceId, row.serviceSlug),
        identity?.name ?? null,
      );
    });
    const detail: PublicBuyerDetail = {
      agentId: agentId.toString(),
      walletAddress: identity?.walletAddress ?? null,
      name: identity?.name ?? null,
      agentURI: identity?.agentURI ?? null,
      firstPurchaseAt: profile.firstPurchaseAt?.toISOString() ?? null,
      lastPurchaseAt: profile.lastPurchaseAt?.toISOString() ?? null,
      reputation: profile.reputation,
      recentPurchases,
    };
    res.json(detail);
  });
}
