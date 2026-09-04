import express from "express";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";
import { llmsFull, readSkill } from "../src/standardRail/skills.js";
import { PINNED_BUYER_CLI } from "../src/standardRail/buyerCli.js";
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
const REFRESHED_AT = new Date("2026-09-03T16:00:00.000Z");
const PUBLIC_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300";
const PURCHASE = {
  orderKey: `0x${"89".repeat(32)}`,
  txHash: `0x${"90".repeat(32)}`,
  payer: "0x8888888888888888888888888888888888888888",
  buyerAgentId: "42",
  buyerName: "Test Buyer",
  amount: "5000000",
  outcomeId: "domain-registration",
  timestamp: "2026-08-13T12:00:00.000Z",
} as const;
let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

// Node's fetch adds Cache-Control: no-cache to a request that carries its own
// validator, which rightly disables the 304, so revalidation is exercised over
// a plain HTTP request.
function conditionalGet(url: string, etag: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { "if-none-match": etag } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

async function startMeta(outcomes: PublicChainMetadataV3["outcomes"]): Promise<string> {
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
      publicOutcomes: async () => outcomes,
      publicProjectionRefreshedAt: () => REFRESHED_AT,
    } as never,
  }));
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", (error?: Error) =>
      error ? reject(error) : resolve(listener)
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}

describe("standard rail metadata", () => {
  it("publishes the gateway-owned non-empty daski-chain v3 contract", async () => {
    const root = await startMeta(CHAIN_FIXTURE.outcomes);

    const response = await fetch(`${root}/.well-known/daski-chain.json`);
    const body = await response.json() as Record<string, unknown>;

    expect(body).toEqual(CHAIN_FIXTURE);
    expect(body).toMatchObject({
      version: 3,
      outcomeSchemaVersion: 1,
      contracts: { ...ADDRESSES, eas: EAS, usdc: USDC },
    });
    expect(JSON.stringify(body)).not.toContain("fulfillmentObligationHash");
    expect(JSON.stringify(body)).not.toContain("jurisdictionObligationHashes");

    // Served from the warm projection: cacheable, revalidatable, and dated.
    expect(response.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(response.headers.get("daski-projection-refreshed-at")).toBe(REFRESHED_AT.toISOString());
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await conditionalGet(`${root}/.well-known/daski-chain.json`, etag!))
      .toEqual({ status: 304, body: "" });

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

    const legacy = await (await fetch(`${root}/.well-known/skills/index.json`)).json() as {
      skills: Array<{ name: string; description: string; files: string[] }>;
    };
    expect(legacy).toEqual({
      skills: [{ name: "daski", description: expect.stringContaining("Daski"), files: ["SKILL.md"] }],
    });
    expect(await (await fetch(`${root}/.well-known/skills/daski/SKILL.md`)).text()).toBe(installable);

    const mcp = await (await fetch(`${root}/.well-known/mcp.json`)).json() as {
      tools: string[];
      skills: Record<string, string>;
      buyerCli: typeof PINNED_BUYER_CLI;
      steadyStatePrompt: string;
    };
    expect(mcp.tools).toContain("daski_get_setup_guide");
    expect(mcp.tools).toContain("daski_get_order_access");
    expect(mcp.tools).toContain("daski_get_outcome_requirements");
    expect(mcp.skills.setup).toBe("https://gateway.example/skills/setup.md");
    expect(mcp.steadyStatePrompt).toBe("Use Daski to [your task].");
    // The pinned buyer CLI is machine-readable so `daski doctor` can compare
    // its own version against it instead of an agent reading the pin by eye.
    expect(mcp.buyerCli).toEqual(PINNED_BUYER_CLI);
    expect(mcp.buyerCli.version).toMatch(/^\d+\.\d+\.\d+$/);

    const llms = await (await fetch(`${root}/llms.txt`)).text();
    expect(llms).toContain("MCP: https://gateway.example/mcp");
    expect(llms).toContain("https://gateway.example/skills/SKILL.md");
  });

  it("pins one buyer CLI release in setup.md, SKILL.md guidance, and the well-known document", async () => {
    const { package: pkg, version, repository, verify, install } = PINNED_BUYER_CLI;
    const setup = (await readSkill("setup")).content;
    // Every mention of the package in the guide names the pinned version;
    // a stale prose pin is how an old install went unnoticed on 2026-09-04.
    const mentions = setup.match(/@daski\/pay@[0-9][^\s`]*/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    for (const mention of mentions) expect(mention).toBe(`${pkg}@${version}`);
    expect(setup).toContain(`The pinned release is \`${pkg}@${version}\`.`);
    expect(setup).toContain(verify);
    expect(setup).toContain(install);
    expect(setup).toContain(repository);
    // Detection compares the doctor's cliVersion with the pin, and names where
    // the pin is published for machines.
    expect(setup).toContain("`cliVersion`");
    expect(setup).toContain("`buyerCli.version` in `/.well-known/mcp.json`");
    // The documented signing path is the one the pinned release completes.
    expect(setup).toContain("daski buy --provider");
    const buy = (await readSkill("buy")).content;
    expect(buy).toContain("| PAYMENT_IDENTIFIER_UNKNOWN |");
    expect(buy).toContain("| PAYMENT_IDENTIFIER_CONFLICT |");
  });

  it("publishes the compact activity projection with the same caching policy", async () => {
    const outcome = structuredClone(CHAIN_FIXTURE.outcomes[0]!);
    outcome.serviceReputation.recentPurchases = [PURCHASE];
    const root = await startMeta([outcome]);

    const response = await fetch(`${root}/public/v3/activity`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(response.headers.get("daski-projection-refreshed-at")).toBe(REFRESHED_AT.toISOString());
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await response.json()).toEqual({
      generatedAt: REFRESHED_AT.toISOString(),
      network: "base-sepolia",
      chainId: 84532,
      contracts: { ...ADDRESSES, eas: EAS, usdc: USDC },
      safeBlock: "12345690",
      serviceCount: 1,
      totalPaid: "5000000",
      transactionCount: "2",
      purchases: [{
        ...PURCHASE,
        serviceId: outcome.serviceId,
        serviceName: "Domain Management",
        skillName: "Register Domain",
      }],
    });

    expect(await conditionalGet(`${root}/public/v3/activity`, etag!))
      .toEqual({ status: 304, body: "" });

    const limited = await (await fetch(`${root}/public/v3/activity?limit=1`)).json() as {
      purchases: unknown[];
    };
    expect(limited.purchases).toHaveLength(1);
    for (const limit of ["0", "201", "abc", "1e2"]) {
      const rejected = await fetch(`${root}/public/v3/activity?limit=${limit}`);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: { code: "INVALID_LIMIT", message: "limit must be an integer from 1 to 200." },
      });
    }
  });
});
