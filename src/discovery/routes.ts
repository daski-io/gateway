import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "./cache.js";
import {
  applyDiscoverFilters,
  formatForRestDiscover,
  type DiscoverFilters,
} from "./format.js";

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
  if (typeof req.query.category === "string") {
    filters.category = req.query.category;
  } else if (req.query.category !== undefined) {
    return { error: "category must be a string" };
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
    const all = cache.getAll();
    const filtered = applyDiscoverFilters(all, parsed);
    res.json({
      acceptedToken: buildAcceptedToken(config),
      providers: filtered.map(formatForRestDiscover),
      cachedAt: cache.getLastRefresh()?.toISOString() ?? null,
    });
  });

  router.get("/providers/:tokenId", (req: Request, res: Response) => {
    let tokenId: bigint;
    const raw = req.params.tokenId;
    try {
      tokenId = BigInt(String(raw));
    } catch {
      res.status(404).json({
        error: {
          code: "PROVIDER_NOT_FOUND",
          message: "provider is not whitelisted or not in the cache",
        },
      });
      return;
    }
    const provider = cache.get(tokenId);
    if (!provider) {
      res.status(404).json({
        error: {
          code: "PROVIDER_NOT_FOUND",
          message: "provider is not whitelisted or not in the cache",
        },
      });
      return;
    }
    res.json(formatForRestDiscover(provider));
  });

  return router;
}
