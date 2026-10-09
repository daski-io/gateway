import express from "express";
import type { Address, Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createMarketplaceRouter } from "../src/marketplace/routes.js";
import { MarketplaceNotFoundError, type MarketplaceChainReader } from "../src/marketplace/reader.js";

const address = "0x1111111111111111111111111111111111111111" as Address;
const serviceId = `0x${"22".repeat(32)}` as Hex;
let server: Server | undefined;

function reader(): MarketplaceChainReader {
  return {
    addresses: {
      identityRegistry: address,
      agentIndex: address,
      providerRegistry: address,
      serviceRegistry: address,
      validationRegistry: address,
      reputationStorage: address,
    },
    resolveWallet: vi.fn(async () => ({ agentId: "7", found: true })),
    listProviders: vi.fn(async (offset, limit) => ({ offset, limit, total: "1", providers: [] })),
    getProvider: vi.fn(async (agentId) => ({ agentId: agentId.toString() })),
    getService: vi.fn(async (id) => ({
      providerAgentId: "7",
      serviceId: id,
      serviceSlug: "service",
      version: "1",
      serviceUri: "https://provider.example/agent-cards/service.json",
      serviceWallet: address,
      createdAt: "1",
      active: true,
      standardReputation: {
        completed: "0", failed: "0", canceled: "0", confirmed: "0",
        notConfirmed: "0", refundedAmount: "0", transactions: "0", safeBlock: "1",
      },
    })),
    readRecovered: vi.fn(async () => "1"),
  };
}

const PROVIDER_REPUTATION = {
  completed: "4", failed: "2", canceled: "0", confirmed: "3", notConfirmed: "0", transactions: "6", safeBlock: "120",
};
const SERVICE_REPUTATION = {
  completed: "4", failed: "2", canceled: "0", confirmed: "3", notConfirmed: "0",
  refundedAmount: "0", transactions: "6", safeBlock: "121",
};

function reputationReader(readRecovered: MarketplaceChainReader["readRecovered"]): MarketplaceChainReader {
  const chainReader = reader();
  chainReader.getProvider = vi.fn(async (agentId: bigint) => ({
    agentId: agentId.toString(),
    standardReputation: PROVIDER_REPUTATION,
  }));
  chainReader.getService = vi.fn(async (id: Hex) => ({
    ...await reader().getService(id),
    standardReputation: SERVICE_REPUTATION,
  }));
  chainReader.readRecovered = vi.fn(readRecovered);
  return chainReader;
}

async function start(chainReader: MarketplaceChainReader): Promise<string> {
  const app = express();
  app.use(createMarketplaceRouter(chainReader));
  const listener = await new Promise<Server>((resolve, reject) => {
    const created: Server = app.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) reject(error);
      else resolve(created);
    });
  });
  server = listener;
  const details = listener.address();
  if (!details || typeof details === "string") throw new Error("test listener unavailable");
  return `http://127.0.0.1:${details.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("payment-independent marketplace registry", () => {
  it("lists provider records with bounded pagination", async () => {
    const chainReader = reader();
    const baseUrl = await start(chainReader);
    const response = await fetch(`${baseUrl}/public/v2/registry/providers?offset=2&limit=5`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offset: 2, limit: 5, total: "1", providers: [] });
    expect(chainReader.listProviders).toHaveBeenCalledWith(2, 5);
  });

  it("rejects malformed identifiers before a chain read", async () => {
    const chainReader = reader();
    const baseUrl = await start(chainReader);
    const [agent, service] = await Promise.all([
      fetch(`${baseUrl}/public/v2/registry/providers/not-a-number`),
      fetch(`${baseUrl}/public/v2/registry/services/not-bytes32`),
    ]);
    expect(agent.status).toBe(400);
    expect(service.status).toBe(400);
    expect(chainReader.getProvider).not.toHaveBeenCalled();
    expect(chainReader.getService).not.toHaveBeenCalled();
  });

  it("publishes the standard-order reputation trust boundary", async () => {
    const baseUrl = await start(reader());
    const response = await fetch(`${baseUrl}/public/v2/registry/contracts`);
    expect(await response.json()).toMatchObject({
      reputationModel: "standard-order-v1",
      eligibilityTrustBoundary: expect.stringContaining("final x402 chain evidence"),
    });
    expect(serviceId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([
    { label: "the recovered figure", answer: async () => "1", expected: "1" },
    { label: "null where recoveries are unsupported", answer: async () => null, expected: null },
    { label: "null when the read fails", answer: async () => { throw new Error("rpc offline"); }, expected: null },
  ])("adds $label to the provider and service reputation", async ({ answer, expected }) => {
    const chainReader = reputationReader(answer);
    const baseUrl = await start(chainReader);

    const [provider, service] = await Promise.all([
      fetch(`${baseUrl}/public/v2/registry/providers/7`),
      fetch(`${baseUrl}/public/v2/registry/services/${serviceId}`),
    ]);

    expect(provider.status).toBe(200);
    expect(await provider.json()).toEqual({
      agentId: "7",
      standardReputation: { ...PROVIDER_REPUTATION, recovered: expected },
    });
    expect(service.status).toBe(200);
    expect(await service.json()).toMatchObject({
      serviceId,
      standardReputation: { ...SERVICE_REPUTATION, recovered: expected },
    });
    // Each figure is read at the safe block of the stats it joins.
    expect(chainReader.readRecovered).toHaveBeenCalledTimes(2);
    expect(chainReader.readRecovered).toHaveBeenCalledWith({ kind: "provider", agentId: 7n }, 120n);
    expect(chainReader.readRecovered).toHaveBeenCalledWith({ kind: "service", serviceId }, 121n);
  });

  it("reads no recovered figure for a record that is not found", async () => {
    const chainReader = reputationReader(async () => "1");
    chainReader.getProvider = vi.fn(async () => { throw new MarketplaceNotFoundError("provider", "42"); });
    const baseUrl = await start(chainReader);

    const response = await fetch(`${baseUrl}/public/v2/registry/providers/42`);

    expect(response.status).toBe(404);
    expect(chainReader.readRecovered).not.toHaveBeenCalled();
  });
});
