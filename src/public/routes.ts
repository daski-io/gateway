import { Router } from "express";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import {
  BlockNumberCache,
  ProviderReputationCache,
  ServiceReputationCache,
} from "./cache/reputation.js";
import { ServiceAggregatesCache } from "./cache/serviceAggregates.js";
import { BuyerIdentityCache } from "./cache/buyerIdentity.js";
import {
  BuyerLeaderboardCache,
  BuyerProfileCache,
} from "./cache/buyerProfiles.js";
import { registerServiceRoutes } from "./serviceRoutes.js";
import { registerActivityRoutes } from "./activityRoutes.js";
import { registerBuyerRoutes } from "./buyerRoutes.js";

const AGGREGATE_SAMPLE_LIMIT = 200;

export interface PublicRouterDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
  blockNumberCacheTtlMs?: number;
  reputationCacheTtlMs?: number;
  serviceAggregatesCacheTtlMs?: number;
  buyerNameCacheTtlMs?: number;
  buyerProfileCacheTtlMs?: number;
  buyerLeaderboardCacheTtlMs?: number;
}

export function createPublicRouter(deps: PublicRouterDeps): Router {
  const router = Router();
  const context = {
    config: deps.config,
    cache: deps.cache,
    queries: deps.queries,
    blockCache: new BlockNumberCache(
      deps.reader,
      deps.blockNumberCacheTtlMs,
    ),
    reputationCache: new ProviderReputationCache(
      deps.reader,
      deps.queries,
      AGGREGATE_SAMPLE_LIMIT,
      deps.reputationCacheTtlMs,
    ),
    serviceReputationCache: new ServiceReputationCache(
      deps.reader,
      deps.queries,
      deps.reputationCacheTtlMs,
    ),
    serviceAggregatesCache: new ServiceAggregatesCache(
      deps.queries,
      AGGREGATE_SAMPLE_LIMIT,
      deps.serviceAggregatesCacheTtlMs,
    ),
    buyerIdentityCache: new BuyerIdentityCache(
      deps.reader,
      deps.queries,
      {
        ipfsGatewayUrl: deps.config.ipfsGatewayUrl,
        fetchFn: deps.buyerAgentCardFetch,
      },
      deps.buyerNameCacheTtlMs,
    ),
    buyerProfileCache: new BuyerProfileCache(
      deps.queries,
      10,
      deps.buyerProfileCacheTtlMs,
    ),
    buyerLeaderboardCache: new BuyerLeaderboardCache(
      deps.queries,
      deps.buyerLeaderboardCacheTtlMs,
    ),
  };
  registerServiceRoutes(router, context);
  registerActivityRoutes(router, context);
  registerBuyerRoutes(router, context);
  return router;
}
