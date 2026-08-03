import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("fresh provider authority on execution paths", () => {
  let gateway: TestGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
    gateway = null;
  });

  it("blocks task submission before provider dispatch", async () => {
    gateway = await startTestGateway({ providers: [taskProvider()] });
    makeAuthorityUnavailable(gateway, 2n);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
            skillId: "run-task",
            paymentId: "0",
            chainId: 84532,
            serviceArgs: { value: "sensitive" },
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_AUTHORITY_UNAVAILABLE");
      expect(gateway.mockProvider.getLastSendBody()).toBeNull();
    } finally {
      await transport.close();
    }
  });

  it("blocks task submission when only a stale provider card is available", async () => {
    gateway = await startTestGateway({ providers: [taskProvider()] });
    gateway.mockProvider.setAgentCard("/agent-registrations/2.json", {
      name: "Task Provider",
      legalName: "Example Provider, LLC",
      termsUrl: "https://provider.example/terms",
      privacyUrl: "https://provider.example/privacy",
      services: [],
    });
    await gateway.refresh();
    expect(gateway.bundle.cache.get(2n)!.fetchError).toMatch(
      /no A2A service endpoint/,
    );
    expect(gateway.bundle.cache.get(2n)!.cards).toHaveLength(1);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
            skillId: "run-task",
            paymentId: "0",
            chainId: 84532,
            serviceArgs: { value: "sensitive" },
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_AUTHORITY_UNAVAILABLE");
      expect(gateway.mockProvider.getLastSendBody()).toBeNull();
    } finally {
      await transport.close();
    }
  });

  it("blocks direct free services before provider dispatch", async () => {
    const a2aFetch = vi.fn<typeof fetch>();
    gateway = await startTestGateway({
      providers: [directFreeProvider()],
      a2aFetch,
    });
    makeAuthorityUnavailable(gateway, 2n);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_buy_service",
          arguments: {
            providerTokenId: "2",
            skillId: "check-availability",
            serviceSlug: "other",
            walletAddress: "0x1111111111111111111111111111111111111111",
            serviceArgs: { domain: "sensitive.example" },
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_AUTHORITY_UNAVAILABLE");
      expect(a2aFetch).not.toHaveBeenCalled();
    } finally {
      await transport.close();
    }
  });

  it("blocks task status before issuing or forwarding authorization", async () => {
    gateway = await startTestGateway({ providers: [taskProvider()] });
    const providerA2AUrl = `${gateway.mockProvider.baseUrl}/a2a`;
    const mappingId = await gateway.bundle.queries.insertTaskMapping({
      contextId: "authority-context",
      messageId: "authority-message",
      serviceRef: null,
      providerA2AUrl,
      skillId: "run-task",
      buyerTokenId: "5",
    });
    await gateway.bundle.queries.completeTaskMapping(
      mappingId,
      "authority-task",
      "working",
    );
    makeAuthorityUnavailable(gateway, 2n);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: { providerA2AUrl, taskId: "authority-task" },
        }),
      );
      expect(result.code).toBe("PROVIDER_AUTHORITY_UNAVAILABLE");
    } finally {
      await transport.close();
    }
  });

  it("blocks artifact retrieval before contacting its origin", async () => {
    const a2aFetch = vi.fn<typeof fetch>();
    gateway = await startTestGateway({
      a2aFetch,
      providers: [
        {
          ...taskProvider(),
          artifactOrigins: ["https://artifacts.example"],
        },
      ],
    });
    makeAuthorityUnavailable(gateway, 2n);

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: {
            url: "https://artifacts.example/private.pdf",
            taskId: "artifact-task",
            providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_AUTHORITY_UNAVAILABLE");
      expect(a2aFetch).not.toHaveBeenCalled();
    } finally {
      await transport.close();
    }
  });
});

function makeAuthorityUnavailable(
  gateway: TestGateway,
  providerAgentId: bigint,
) {
  gateway.bundle.cache.get(providerAgentId)!.authorityObservedAt = new Date(0);
  gateway.mockChain.getProviderAuthority = async () => {
    throw new Error("provider registry unavailable");
  };
}

function taskProvider() {
  return {
    tokenId: 2n,
    name: "Task Provider",
    priceUsdcSmallest: "0",
    categoryFamily: "other" as const,
    serviceType: "other" as const,
    skills: [
      {
        id: "run-task",
        metadata: {
          paymentRequired: false,
          requiresAssetOwnership: false,
          requiresCapability: false,
        },
      },
    ],
  };
}

function directFreeProvider() {
  return {
    ...taskProvider(),
    skills: [
      {
        id: "check-availability",
        metadata: {
          paymentRequired: false,
          requiresAssetOwnership: false,
          requiresCapability: false,
          directEndpoint: "/availability",
          directResultKind: "availability",
        },
      },
    ],
  };
}

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
