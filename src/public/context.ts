import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type {
  BlockNumberCache,
  ProviderReputationCache,
  ServiceReputationCache,
} from "./cache/reputation.js";
import type { ServiceAggregatesCache } from "./cache/serviceAggregates.js";
import type { BuyerIdentityCache } from "./cache/buyerIdentity.js";
import type {
  BuyerLeaderboardCache,
  BuyerProfileCache,
} from "./cache/buyerProfiles.js";

export interface PublicRouteContext {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  blockCache: BlockNumberCache;
  reputationCache: ProviderReputationCache;
  serviceReputationCache: ServiceReputationCache;
  serviceAggregatesCache: ServiceAggregatesCache;
  buyerIdentityCache: BuyerIdentityCache;
  buyerProfileCache: BuyerProfileCache;
  buyerLeaderboardCache: BuyerLeaderboardCache;
}
