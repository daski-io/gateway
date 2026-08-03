import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Embedder } from "../src/discovery/embeddings.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("semantic-search load shedding", () => {
  let gateway: TestGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
    gateway = null;
  });

  it("runs only one local embedding inference at a time", async () => {
    let releaseEmbedding = () => {};
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    let markEmbeddingStarted = () => {};
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    let embedCalls = 0;
    const embedder: Embedder = {
      dim: 384,
      async embed() {
        embedCalls += 1;
        markEmbeddingStarted();
        await embeddingGate;
        return unitVector();
      },
      async embedMany(texts) {
        return texts.map(unitVector);
      },
    };
    gateway = await startTestGateway({
      embedder,
      providers: [
        {
          tokenId: 2n,
          name: "Domain Provider",
          priceUsdcSmallest: "15000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
        },
      ],
    });

    const first = await connectClient(gateway.baseUrl);
    const second = await connectClient(gateway.baseUrl);
    try {
      const firstCall = first.client.callTool({
        name: "daski_search_services",
        arguments: { intent: "register a domain" },
      });
      await embeddingStarted;

      const result = parseResult<{
        ranking: string;
        warning: string;
        providers: unknown[];
      }>(
        await second.client.callTool({
          name: "daski_search_services",
          arguments: { intent: "find email hosting" },
        }),
      );

      expect(embedCalls).toBe(1);
      expect(result.ranking).toBe("busy");
      expect(result.warning).toMatch(/filtered catalog/i);
      expect(result.providers).toHaveLength(1);

      releaseEmbedding();
      await firstCall;
    } finally {
      releaseEmbedding();
      await Promise.all([first.transport.close(), second.transport.close()]);
    }
  });
});

function unitVector(): Float32Array {
  const vector = new Float32Array(384);
  vector[0] = 1;
  return vector;
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
  const client = new Client({ name: "load-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}
