import { Router } from "express";
import { getAddress, type Address, type Hex } from "viem";
import type { MarketplaceChainReader } from "./reader.js";

function positiveDecimal(raw: string): bigint | null {
  if (!/^(0|[1-9]\d{0,77})$/.test(raw)) return null;
  const value = BigInt(raw);
  return value <= (1n << 256n) - 1n ? value : null;
}

function pageValue(raw: unknown, fallback: number, maximum: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

async function sendChainRead(res: import("express").Response, read: () => Promise<unknown>) {
  try {
    res.json(await read());
  } catch {
    res.status(502).json({
      error: { code: "MARKETPLACE_CHAIN_READ_FAILED", message: "Marketplace chain state is unavailable." },
    });
  }
}

export function createMarketplaceRouter(reader: MarketplaceChainReader): Router {
  const router = Router();
  router.get("/public/v2/registry/contracts", (_req, res) => {
    res.json({
      ...reader.addresses,
      historicalReputationOnly: true,
      standardRailWritesReputation: false,
    });
  });
  router.get("/public/v2/registry/identity/:wallet", async (req, res) => {
    let wallet: Address;
    try {
      wallet = getAddress(req.params.wallet ?? "");
    } catch {
      res.status(400).json({ error: { code: "INVALID_WALLET", message: "wallet must be an EVM address." } });
      return;
    }
    await sendChainRead(res, () => reader.resolveWallet(wallet));
  });
  router.get("/public/v2/registry/providers", async (req, res) => {
    const offset = pageValue(req.query.offset, 0, 1_000_000);
    const limit = pageValue(req.query.limit, 25, 100);
    if (offset === null || limit === null || limit === 0) {
      res.status(400).json({
        error: { code: "INVALID_PAGE", message: "offset and limit must be bounded non-negative integers." },
      });
      return;
    }
    await sendChainRead(res, () => reader.listProviders(offset, limit));
  });
  router.get("/public/v2/registry/providers/:agentId", async (req, res) => {
    const agentId = positiveDecimal(req.params.agentId ?? "");
    if (agentId === null) {
      res.status(400).json({ error: { code: "INVALID_AGENT_ID", message: "agentId must be uint256 decimal." } });
      return;
    }
    await sendChainRead(res, () => reader.getProvider(agentId));
  });
  router.get("/public/v2/registry/services/:serviceId", async (req, res) => {
    const serviceId = req.params.serviceId;
    if (!serviceId || !/^0x[0-9a-fA-F]{64}$/.test(serviceId)) {
      res.status(400).json({ error: { code: "INVALID_SERVICE_ID", message: "serviceId must be bytes32." } });
      return;
    }
    await sendChainRead(res, () => reader.getService(serviceId as Hex));
  });
  return router;
}
