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
          name: "Daski LLC Formation",
          priceUsdcSmallest: "250000000", // 250 USDC
          categoryFamily: "business-formation",
          serviceType: "llc-formation",
          jurisdictions: ["US"],
          skills: [
            {
              id: "form-llc",
              metadata: { fulfillmentMode: "hybrid" },
            },
          ],
        },
        {
          tokenId: 2n,
          name: "Daski Domain Registration",
          priceUsdcSmallest: "15000000", // 15 USDC
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          jurisdictions: ["global"],
        },
        {
          tokenId: 3n,
          name: "Daski Website Hosting",
          priceUsdcSmallest: "10000000", // 10 USDC
          categoryFamily: "domains-web",
          serviceType: "domains-web-other",
          jurisdictions: ["US"],
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
    const tokens = json.providers.map((p: any) => p.agentId).sort();
    expect(tokens).toEqual(["1", "2", "3"]);

    const llc = json.providers.find((p: any) => p.agentId === "1");
    expect(llc.cards[0].agentCard.name).toBe("Daski LLC Formation");
    expect(llc.cards[0].agentCard.extensions[DASKI_A2A_EXTENSION_URI].pricing.baseAmount).toBe(
      "250000000",
    );
    expect(llc.fetchError).toBeNull();
  });

  it("filters by category family", async () => {
    const { status, json } = await gateway.discover({
      categoryFamily: "domains-web",
    });
    expect(status).toBe(200);
    expect(json.providers.map((provider: any) => provider.agentId).sort()).toEqual([
      "2",
      "3",
    ]);
  });

  it("filters by controlled service type", async () => {
    const { status, json } = await gateway.discover({
      serviceType: "domain-management",
    });
    expect(status).toBe(200);
    expect(json.providers.map((provider: any) => provider.agentId)).toEqual(["2"]);
  });

  it("treats global services as available in any jurisdiction", async () => {
    const canada = await gateway.discover({ jurisdiction: "CA" });
    expect(canada.status).toBe(200);
    expect(canada.json.providers.map((provider: any) => provider.agentId)).toEqual([
      "2",
    ]);

    const wyoming = await gateway.discover({ jurisdiction: "US-WY" });
    expect(
      wyoming.json.providers.map((provider: any) => provider.agentId).sort(),
    ).toEqual(["1", "2", "3"]);

    const explicitlyGlobal = await gateway.discover({ jurisdiction: "global" });
    expect(
      explicitlyGlobal.json.providers.map((provider: any) => provider.agentId),
    ).toEqual(["2"]);
  });

  it("filters by effective skill fulfillment mode", async () => {
    const { status, json } = await gateway.discover({ fulfillmentMode: "hybrid" });
    expect(status).toBe(200);
    expect(json.providers.map((provider: any) => provider.agentId)).toEqual(["1"]);
  });

  it("filters by maxPrice", async () => {
    const { status, json } = await gateway.discover({ maxPrice: 50 });
    expect(status).toBe(200);
    const tokens = json.providers.map((p: any) => p.agentId).sort();
    expect(tokens).toEqual(["2", "3"]);
  });

  it("rejects unknown category families", async () => {
    const res = await fetch(`${gateway.baseUrl}/discover?categoryFamily=nope`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.code).toBe("INVALID_FILTER");
  });

  it("rejects the removed category filter instead of broadening the query", async () => {
    const res = await fetch(`${gateway.baseUrl}/discover?category=domains`);
    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toMatch(/categoryFamily/);
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
    expect(body.agentId).toBe("2");
    expect(body.cards[0].agentCard.name).toBe("Daski Domain Registration");
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
    expect(json.providers.find((p: any) => p.agentId === "42")).toBeUndefined();
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
    expect(json.providers.find((p: any) => p.agentId === "1")).toBeUndefined();
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
    const broken = json.providers.find((p: any) => p.agentId === "1");
    // keep in cache from previous fetch, with fetchError annotation
    expect(broken).toBeDefined();
    expect(broken.fetchError).toBeTruthy();
  });

  it("does not admit providers with no marketplace extension", async () => {
    // Register a 4th provider WITHOUT the extension.
    gateway.registerProvider({
      tokenId: 4n,
      name: "Plain",
      priceUsdcSmallest: "0",
      categoryFamily: "other",
      serviceType: "other",
      skipExtension: true,
    });
    await gateway.refresh();

    // Invalid cards do not appear even on the raw, unfiltered surface.
    const all = await gateway.discover();
    expect(
      all.json.providers.find((p: any) => p.agentId === "4"),
    ).toBeUndefined();
  });

});
