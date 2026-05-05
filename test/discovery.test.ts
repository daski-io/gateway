import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("discovery", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          erc8004TokenId: 101n,
          name: "Daski LLC Formation",
          priceUsdcSmallest: "250000000", // 250 USDC
          category: "llc-formation",
        },
        {
          tokenId: 2n,
          erc8004TokenId: 102n,
          name: "Daski Domain Registration",
          priceUsdcSmallest: "15000000", // 15 USDC
          category: "domain-registration",
        },
        {
          tokenId: 3n,
          erc8004TokenId: 103n,
          name: "Daski Website Hosting",
          priceUsdcSmallest: "10000000", // 10 USDC
          category: "website-hosting",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("reads providers from the chain and fetches their agent cards", async () => {
    const { status, json } = await gateway.discover();
    expect(status).toBe(200);
    expect(json.providers).toHaveLength(3);
    const tokens = json.providers.map((p: any) => p.tokenId).sort();
    expect(tokens).toEqual(["1", "2", "3"]);

    const llc = json.providers.find((p: any) => p.tokenId === "1");
    expect(llc.agentCard.name).toBe("Daski LLC Formation");
    expect(llc.agentCard.extensions[DASKI_A2A_EXTENSION_URI].pricing.baseAmount).toBe(
      "250000000",
    );
    expect(llc.fetchError).toBeNull();
  });

  it("filters by category", async () => {
    const { status, json } = await gateway.discover({
      category: "domain-registration",
    });
    expect(status).toBe(200);
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0].tokenId).toBe("2");
  });

  it("filters by maxPrice", async () => {
    const { status, json } = await gateway.discover({ maxPrice: 50 });
    expect(status).toBe(200);
    const tokens = json.providers.map((p: any) => p.tokenId).sort();
    expect(tokens).toEqual(["2", "3"]);
  });

  it("returns an empty list when filters match nothing", async () => {
    const { status, json } = await gateway.discover({
      category: "nope",
    });
    expect(status).toBe(200);
    expect(json.providers).toEqual([]);
  });

  it("rejects malformed maxPrice", async () => {
    const res = await fetch(`${gateway.baseUrl}/discover?maxPrice=notanumber`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe("INVALID_FILTER");
  });

  it("returns 404 for unknown providers", async () => {
    const res = await fetch(`${gateway.baseUrl}/providers/999`);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error.code).toBe("PROVIDER_NOT_FOUND");
  });

  it("returns a single provider detail", async () => {
    const res = await fetch(`${gateway.baseUrl}/providers/2`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.tokenId).toBe("2");
    expect(body.agentCard.name).toBe("Daski Domain Registration");
  });

  it("ignores non-whitelisted providers even if they are on-chain", async () => {
    // Add a provider on-chain but DO NOT whitelist it.
    gateway.mockChain.addProvider(42n, {
      walletAddress: "0x00000000000000000000000000000000000000ff",
      agentId: 42n,
      agentURI: `${gateway.mockProvider.baseUrl}/agent-cards/42.json`,
      registrationTime: 1n,
      isActive: true,
    });
    gateway.mockProvider.setAgentCard("/agent-cards/42.json", {
      name: "Non-whitelisted",
      url: `${gateway.mockProvider.baseUrl}/a2a`,
      skills: [],
    });

    await gateway.refresh();
    const { json } = await gateway.discover();
    expect(json.providers.find((p: any) => p.tokenId === "42")).toBeUndefined();
  });

  it("excludes inactive providers", async () => {
    gateway.mockChain.addProvider(1n, {
      walletAddress: "0x0000000000000000000000000000000000000001",
      agentId: 1n,
      agentURI: `${gateway.mockProvider.baseUrl}/agent-cards/1.json`,
      registrationTime: 1n,
      isActive: false,
    });
    await gateway.refresh();
    const { json } = await gateway.discover();
    expect(json.providers.find((p: any) => p.tokenId === "1")).toBeUndefined();
  });

  it("records fetchError but keeps the provider visible when the agent card fetch fails", async () => {
    // Break the LLC provider's card URL.
    gateway.mockChain.addProvider(1n, {
      walletAddress: "0x0000000000000000000000000000000000000001",
      agentId: 1n,
      agentURI: "http://127.0.0.1:1/nowhere.json",
      registrationTime: 1n,
      isActive: true,
    });
    await gateway.refresh();
    const { json } = await gateway.discover();
    const broken = json.providers.find((p: any) => p.tokenId === "1");
    // keep in cache from previous fetch, with fetchError annotation
    expect(broken).toBeDefined();
    expect(broken.fetchError).toBeTruthy();
  });

  it("excludes providers with no marketplace extension from filtered queries", async () => {
    // Register a 4th provider WITHOUT the extension.
    gateway.registerProvider({
      tokenId: 4n,
      erc8004TokenId: 104n,
      name: "Plain",
      priceUsdcSmallest: "0",
      category: "whatever",
      skipExtension: true,
    });
    await gateway.refresh();

    // unfiltered returns it
    const all = await gateway.discover();
    expect(all.json.providers.find((p: any) => p.tokenId === "4")).toBeDefined();

    // filtered excludes it
    const filtered = await gateway.discover({ maxPrice: 1_000_000 });
    expect(
      filtered.json.providers.find((p: any) => p.tokenId === "4"),
    ).toBeUndefined();
  });
});
