import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "./cache.js";
import {
  isCategoryFamily,
  isFulfillmentMode,
  isJurisdiction,
  isServiceType,
  isServiceTypeForFamily,
} from "../serviceTaxonomy.js";
import { hasMarketplaceService } from "./agentCard.js";
import { applyDiscoverFilters, type DiscoverFilters } from "./filters.js";
import { formatForRestDiscover } from "./restPresentation.js";

/// Wallet-facing description of which ERC-20 the gateway settles in. Surfaced
/// at the top of /discover so agents can pre-check balance against the right
/// contract — Daski uses a custom test USDC on Sepolia, NOT Circle's, and a
/// fresh wallet hitting Circle's faucet would land on the wrong address.
export interface AcceptedToken {
  address: string;
  name: string;
  version: string;
  chainId: number;
  network: "base" | "base-sepolia";
}

export function buildAcceptedToken(config: Config): AcceptedToken {
  return {
    address: config.usdcAddress,
    name: config.usdcName,
    version: config.usdcVersion,
    chainId: config.chainId,
    network: config.network,
  };
}

function parseFilters(req: Request): DiscoverFilters | { error: string } {
  const filters: DiscoverFilters = {};
  if (req.query.category !== undefined) {
    return {
      error: "category is not supported; use categoryFamily and serviceType",
    };
  }
  if (typeof req.query.categoryFamily === "string") {
    if (!isCategoryFamily(req.query.categoryFamily)) {
      return { error: "categoryFamily must be an approved family slug" };
    }
    filters.categoryFamily = req.query.categoryFamily;
  } else if (req.query.categoryFamily !== undefined) {
    return { error: "categoryFamily must be a string" };
  }
  if (typeof req.query.serviceType === "string") {
    if (!isServiceType(req.query.serviceType)) {
      return { error: "serviceType must be an accepted service type" };
    }
    filters.serviceType = req.query.serviceType;
  } else if (req.query.serviceType !== undefined) {
    return { error: "serviceType must be a string" };
  }
  if (
    filters.categoryFamily &&
    filters.serviceType &&
    !isServiceTypeForFamily(filters.categoryFamily, filters.serviceType)
  ) {
    return { error: "serviceType does not belong to categoryFamily" };
  }
  if (typeof req.query.jurisdiction === "string") {
    if (!isJurisdiction(req.query.jurisdiction)) {
      return {
        error:
          "jurisdiction must be 'global', an assigned ISO 3166-1 alpha-2 " +
          "country code, or a recognized ISO 3166-2 subdivision code",
      };
    }
    filters.jurisdiction = req.query.jurisdiction;
  } else if (req.query.jurisdiction !== undefined) {
    return { error: "jurisdiction must be a string" };
  }
  if (typeof req.query.fulfillmentMode === "string") {
    if (!isFulfillmentMode(req.query.fulfillmentMode)) {
      return {
        error: "fulfillmentMode must be automated, human, or hybrid",
      };
    }
    filters.fulfillmentMode = req.query.fulfillmentMode;
  } else if (req.query.fulfillmentMode !== undefined) {
    return { error: "fulfillmentMode must be a string" };
  }
  if (req.query.maxPrice !== undefined) {
    if (typeof req.query.maxPrice !== "string") {
      return { error: "maxPrice must be a numeric string" };
    }
    const n = Number(req.query.maxPrice);
    if (!Number.isFinite(n) || n < 0) {
      return { error: "maxPrice must be a non-negative number" };
    }
    filters.maxPrice = n;
  }
  return filters;
}

export function createDiscoveryRouter(
  cache: DiscoveryCache,
  config: Config,
): Router {
  const router = Router();

  router.get("/discover", (req: Request, res: Response) => {
    const parsed = parseFilters(req);
    if ("error" in parsed) {
      res.status(400).json({
        error: { code: "INVALID_FILTER", message: parsed.error },
      });
      return;
    }
    const all = cache.getAll().filter(hasMarketplaceService);
    const filtered = applyDiscoverFilters(all, parsed);
    res.json({
      acceptedToken: buildAcceptedToken(config),
      providers: filtered.map((provider) =>
        formatForRestDiscover(provider, config),
      ),
      cachedAt: cache.getLastRefresh()?.toISOString() ?? null,
    });
  });

  router.get("/providers/:agentId", (req: Request, res: Response) => {
    let agentId: bigint;
    const raw = req.params.agentId;
    try {
      agentId = BigInt(String(raw));
    } catch {
      res.status(404).json({
        error: {
          code: "PROVIDER_NOT_FOUND",
          message: "provider is not currently admitted or not in the cache",
        },
      });
      return;
    }
    const provider = cache.get(agentId);
    if (!provider || !hasMarketplaceService(provider)) {
      res.status(404).json({
        error: {
          code: "PROVIDER_NOT_FOUND",
          message: "provider is not currently admitted or not in the cache",
        },
      });
      return;
    }
    res.json(formatForRestDiscover(provider, config));
  });

  return router;
}
