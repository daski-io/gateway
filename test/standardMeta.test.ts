import express from "express";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";
import { llmsFull, readSkill } from "../src/standardRail/skills.js";
import type { PublicChainMetadataV3 } from "../src/standardRail/types.js";

const CHAIN_FIXTURE = JSON.parse(readFileSync(
  new URL("./vectors/daski-chain-v3.json", import.meta.url),
  "utf8",
)) as PublicChainMetadataV3;

const ADDRESSES = {
  identityRegistry: "0x1111111111111111111111111111111111111111",
  agentIndex: "0x2222222222222222222222222222222222222222",
  providerRegistry: "0x3333333333333333333333333333333333333333",
  serviceRegistry: "0x4444444444444444444444444444444444444444",
  validationRegistry: "0x5555555555555555555555555555555555555555",
  reputationStorage: "0x6666666666666666666666666666666666666666",
} as const;
const EAS = "0x7777777777777777777777777777777777777777";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("standard rail metadata", () => {
  it("publishes the gateway-owned non-empty daski-chain v3 contract", async () => {
    const app = express();
    app.use(createStandardMetaRouter({
      config: {
        chainId: 84532,
        network: "base-sepolia",
        x402Network: "eip155:84532",
        publicUrl: "https://gateway.example",
        mcpPath: "/mcp",
        marketplaceContracts: ADDRESSES,
        usdc: { address: USDC },
      } as unknown as Config,
      railConfig: { easAddress: EAS } as never,
      pool: { query: async () => ({ rows: [] }) } as never,
      lifecycle: { isStopping: () => false } as never,
      service: {
        railProfileHash: CHAIN_FIXTURE.paymentRail.activeRailProfileHash,
        publicOutcomes: async () => CHAIN_FIXTURE.outcomes,
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

    expect(body).toEqual(CHAIN_FIXTURE);
    expect(body).toMatchObject({
      version: 3,
      outcomeSchemaVersion: 1,
      contracts: { ...ADDRESSES, eas: EAS, usdc: USDC },
    });
    expect(JSON.stringify(body)).not.toContain("fulfillmentObligationHash");
    expect(JSON.stringify(body)).not.toContain("jurisdictionObligationHashes");

    const root = `http://127.0.0.1:${address.port}`;
    const setup = await (await fetch(`${root}/skills/setup.md`)).text();
    expect(setup).toBe((await readSkill("setup")).content);
    expect(setup).toContain("daski_get_payment_challenge");

    const index = await (await fetch(`${root}/.well-known/agent-skills/index.json`))
      .json() as {
        skills: Array<{ name: string; sha256: string; bytes: number; url: string }>;
      };
    const setupEntry = index.skills.find((skill) => skill.name === "setup");
    expect(setupEntry).toMatchObject({
      url: "https://gateway.example/skills/setup.md",
      bytes: Buffer.byteLength(setup),
      sha256: createHash("sha256").update(setup).digest("hex"),
    });

    const full = await (await fetch(`${root}/llms-full.txt`)).text();
    expect(full).toBe(await llmsFull());
    const installable = await (await fetch(`${root}/skills/SKILL.md`)).text();
    expect(await (await fetch(`${root}/skill.md`)).text()).toBe(installable);
    expect(await (await fetch(`${root}/SKILL.md`)).text()).toBe(installable);

    const mcp = await (await fetch(`${root}/.well-known/mcp.json`)).json() as {
      tools: string[];
      skills: Record<string, string>;
      steadyStatePrompt: string;
    };
    expect(mcp.tools).toContain("daski_get_setup_guide");
    expect(mcp.tools).toContain("daski_get_order_access");
    expect(mcp.skills.setup).toBe("https://gateway.example/skills/setup.md");
    expect(mcp.steadyStatePrompt).toBe("Use Daski to [your task].");

    const llms = await (await fetch(`${root}/llms.txt`)).text();
    expect(llms).toContain("MCP: https://gateway.example/mcp");
    expect(llms).toContain("https://gateway.example/skills/SKILL.md");
  });
});
