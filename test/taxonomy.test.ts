import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import {
  isJurisdiction,
  jurisdictionsOverlap,
} from "../src/serviceTaxonomy.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("service taxonomy admission", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({ providers: [] });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("keeps invalid cards out of discovery, public listings, and purchase", async () => {
    const invalidExtensions: Array<Record<string, unknown>> = [
      {
        categoryFamily: "unknown",
        serviceType: "other",
        jurisdictions: ["global"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "agent-mailbox",
        jurisdictions: ["global"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["United States"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["global"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["global"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["global", "US"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["ZZ"],
      },
      {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["US-ZZZ"],
      },
    ];

    for (let index = 0; index < invalidExtensions.length; index++) {
      const tokenId = BigInt(10 + index);
      gateway.registerProvider({
        tokenId,
        name: `Invalid ${index}`,
        priceUsdcSmallest: "1000000",
        categoryFamily: "domains-web",
        serviceType: "domain-management",
      });
      gateway.mockProvider.setAgentCard(`/agent-cards/${tokenId}.json`, {
        name: `Invalid ${index}`,
        legalName: "Example Provider, LLC",
        termsUrl: "https://provider.example/terms",
        privacyUrl: "https://provider.example/privacy",
        url: `${gateway.mockProvider.baseUrl}/a2a`,
        skills:
          index === 4
            ? []
            : [
                {
                  id: "register-domain",
                  name: "Register Domain",
                  description: "Register a domain",
                  metadata: {
                    [DASKI_A2A_EXTENSION_URI]:
                      index === 3 ? {} : { fulfillmentMode: "automated" },
                  },
                },
              ],
        extensions: {
          [DASKI_A2A_EXTENSION_URI]: invalidExtensions[index],
        },
      });
    }
    await gateway.refresh();

    const discovery = await gateway.discover();
    const discoveredIds = discovery.json.providers.map((provider: any) =>
      provider.tokenId,
    );
    const publicResponse = await fetch(`${gateway.baseUrl}/public/v1/services`);
    const publicBody: any = await publicResponse.json();
    const publicIds = publicBody.services.map((service: any) => service.agentId);

    for (let index = 0; index < invalidExtensions.length; index++) {
      const token = 10 + index;
      expect(discoveredIds).not.toContain(String(token));
      expect(publicIds).not.toContain(String(token));

      const detail = await fetch(`${gateway.baseUrl}/providers/${token}`);
      expect(detail.status).toBe(404);

      const purchase = await fetch(`${gateway.baseUrl}/purchase/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: gateway.buyerAddress,
          buyerTokenId: "5",
          skillId: "register-domain",
          serviceArgs: {},
        }),
      });
      expect(purchase.status).toBe(404);
    }
  });
});

describe("jurisdiction rules", () => {
  it("accepts only assigned country and recognized subdivision codes", () => {
    expect(isJurisdiction("US")).toBe(true);
    expect(isJurisdiction("US-WY")).toBe(true);
    expect(isJurisdiction("US-ZZZ")).toBe(false);
    expect(isJurisdiction("ZZ")).toBe(false);
    expect(isJurisdiction("global")).toBe(true);
  });

  it("matches global, country, and subdivision availability", () => {
    expect(jurisdictionsOverlap(["global"], "CA")).toBe(true);
    expect(jurisdictionsOverlap(["US"], "US-WY")).toBe(true);
    expect(jurisdictionsOverlap(["US-WY"], "US")).toBe(true);
    expect(jurisdictionsOverlap(["US-CA"], "US-WY")).toBe(false);
    expect(jurisdictionsOverlap(["US"], "global")).toBe(false);
  });
});
