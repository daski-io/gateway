import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("provider catalog authority", () => {
  let gateway: TestGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
    gateway = null;
  });

  it("does not send quote inputs through a retained stale endpoint", async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Domain Provider",
          priceUsdcSmallest: "15000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          skills: [
            {
              id: "register-domain",
              metadata: {
                paymentRequired: true,
                requiredFields: ["domain"],
              },
            },
          ],
        },
      ],
    });
    gateway.mockProvider.setAgentCard("/agent-registrations/2.json", {
      name: "Domain Provider",
      legalName: "Example Provider, LLC",
      termsUrl: "https://provider.example/terms",
      privacyUrl: "https://provider.example/privacy",
      services: [],
    });
    await gateway.refresh();
    expect(gateway.bundle.cache.get(2n)!.cards).toHaveLength(1);
    expect(gateway.bundle.cache.get(2n)!.fetchError).toMatch(
      /no A2A service endpoint/,
    );

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            skillId: "register-domain",
            providerTokenId: "2",
            serviceSlug: "domain-management",
            buyerTokenId: "5",
            walletAddress: gateway.buyerAddress,
            serviceArgs: { domain: "sensitive.example" },
          },
        }),
      );

      expect(result.code).toBe("provider_authority_unavailable");
      expect(gateway.mockProvider.getIssuedQuotes()).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });
});

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
}

function parseResult<T>(result: unknown): T {
  return JSON.parse((result as ToolResultContent).content[0]!.text) as T;
}

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "authority-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}
