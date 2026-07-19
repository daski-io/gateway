import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: unknown): T {
  const content = (result as ToolResultContent).content;
  expect(content[0]).toBeDefined();
  return JSON.parse(content[0]!.text) as T;
}

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "legal-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("legal metadata admission and representation", () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  it("hard-excludes newly invalid metadata from every runtime surface", async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 51n,
          name: "Legal Provider",
          priceUsdcSmallest: "5000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
        },
      ],
    });
    const registrationPath = "/agent-registrations/51.json";
    const registration = (await (
      await fetch(`${gateway.mockProvider.baseUrl}${registrationPath}`)
    ).json()) as Record<string, unknown>;
    gateway.mockProvider.setAgentCard(registrationPath, {
      ...registration,
      termsUrl: "http://provider.example/terms",
    });
    await gateway.refresh();

    const cached = gateway.bundle.cache.get(51n)!;
    expect(cached.providerLegal).toBeNull();
    expect(cached.cards).toEqual([]);

    const discover = await gateway.discover();
    expect(discover.json.providers).toEqual([]);
    expect((await fetch(`${gateway.baseUrl}/providers/51`)).status).toBe(404);
    const publicCatalog = (await (
      await fetch(`${gateway.baseUrl}/public/v1/services`)
    ).json()) as { services: unknown[] };
    expect(publicCatalog.services).toEqual([]);

    const payment = await gateway.purchaseChallenge(51n, {
      buyerTokenId: "5",
    });
    expect(payment.status).toBe(422);
    expect(payment.json.error).toMatch(/legal metadata/i);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {},
      });
      const body = parseToolResult<{ providers: unknown[] }>(result);
      expect(body.providers).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it("overrides provider-supplied nested legal data with canonical values", async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 52n,
          name: "Canonical Legal Provider",
          priceUsdcSmallest: "5000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
        },
      ],
    });
    const cardPath = "/agent-cards/52.json";
    const card = (await (
      await fetch(`${gateway.mockProvider.baseUrl}${cardPath}`)
    ).json()) as Record<string, unknown>;
    const extensions = card.extensions as Record<string, unknown>;
    gateway.mockProvider.setAgentCard(cardPath, {
      ...card,
      extensions: {
        ...extensions,
        [DASKI_A2A_EXTENSION_URI]: {
          ...(extensions[DASKI_A2A_EXTENSION_URI] as Record<string, unknown>),
          legal: {
            marketplaceTermsUrl: "https://evil.example/terms",
            marketplacePrivacyUrl: "https://evil.example/privacy",
            providerLegalName: "Wrong Entity",
            providerTermsUrl: "https://evil.example/provider-terms",
            providerPrivacyUrl: "https://evil.example/provider-privacy",
          },
        },
      },
    });
    await gateway.refresh();

    const expected = {
      marketplaceTermsUrl: gateway.config.marketplaceTermsUrl,
      marketplacePrivacyUrl: gateway.config.marketplacePrivacyUrl,
      providerLegalName: "Example Provider, LLC",
      providerTermsUrl: "https://provider.example/terms",
      providerPrivacyUrl: "https://provider.example/privacy",
    };
    const discover = await gateway.discover();
    const provider = discover.json.providers[0];
    expect(provider.legal).toEqual(expected);
    expect(
      provider.cards[0].agentCard.extensions[DASKI_A2A_EXTENSION_URI].legal,
    ).toEqual(expected);
    expect(provider.cards[0].legal).toEqual(expected);
    expect(
      provider.cards[0].agentCard.extensions[DASKI_A2A_EXTENSION_URI].legal,
    ).toEqual(expected);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {},
      });
      const body = parseToolResult<{
        providers: Array<{ legal: Record<string, string> }>;
      }>(result);
      expect(body.providers[0].legal).toEqual(expected);
    } finally {
      await transport.close();
    }
  });
});
