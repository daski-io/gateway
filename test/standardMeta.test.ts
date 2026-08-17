import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";

const ADDRESSES = {
  identityRegistry: "0x1111111111111111111111111111111111111111",
  agentIndex: "0x2222222222222222222222222222222222222222",
  providerRegistry: "0x3333333333333333333333333333333333333333",
  serviceRegistry: "0x4444444444444444444444444444444444444444",
  validationRegistry: "0x5555555555555555555555555555555555555555",
  reputationStorage: "0x6666666666666666666666666666666666666666",
} as const;
const EAS = "0x7777777777777777777777777777777777777777";
const USDC = "0x8888888888888888888888888888888888888888";
let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("standard rail metadata", () => {
  it("publishes the active reputation and marketplace contracts without listing splitters", async () => {
    const app = express();
    app.use(createStandardMetaRouter({
      config: {
        chainId: 84532,
        network: "base-sepolia",
        x402Network: "eip155:84532",
        publicUrl: "https://gateway.example",
        marketplaceContracts: ADDRESSES,
        usdc: { address: USDC },
      } as unknown as Config,
      railConfig: { easAddress: EAS } as never,
      pool: { query: async () => ({ rows: [] }) } as never,
      lifecycle: { isStopping: () => false } as never,
      service: {
        railProfileHash: `0x${"99".repeat(32)}`,
        publicOutcomes: async () => [],
      } as never,
    }));
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", (error?: Error) =>
        error ? reject(error) : resolve(listener)
      );
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener unavailable");

    const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/daski-chain.json`);
    const body = await response.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      contracts: { ...ADDRESSES, eas: EAS, usdc: USDC },
    });
    expect(JSON.stringify(body)).not.toContain("splitterAddress");
  });
});
