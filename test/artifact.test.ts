import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
}

function parseResult<T>(result: unknown): T {
  const content = (result as ToolResultContent).content;
  expect(content[0]).toBeDefined();
  return JSON.parse(content[0].text) as T;
}

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "artifact-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP artifact delivery", () => {
  const gateways: TestGateway[] = [];

  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  });

  it("completes the audience challenge and refreshes an expired one", async () => {
    const artifactUrl = "https://artifacts.example/entity.pdf";
    const taskId = "task-document-1";
    const pdf = new TextEncoder().encode("%PDF-1.7\nmock formation document");
    const nonce1 = `0x${"11".repeat(32)}`;
    const nonce2 = `0x${"22".repeat(32)}`;
    const challenge = (nonce: string) => {
      const authorization = {
        buyerTokenId: "5",
        taskId,
        action: "document-download",
        nonce,
        expiry: "9999999999",
      };
      return {
        authorization,
        eip712TypedData: {
          domain: { name: "Daski Capability" },
          types: { TaskAccessAuthorization: [] },
          primaryType: "TaskAccessAuthorization",
          message: authorization,
        },
      };
    };
    let calls = 0;
    const a2aFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== artifactUrl) {
        return new Response("unexpected URL", { status: 500 });
      }
      calls += 1;
      const encoded = new Headers(init?.headers).get(
        "X-Daski-Task-Capability",
      );
      if (!encoded) {
        return Response.json(
          {
            error: "audience_proof_required",
            capabilityChallenge: challenge(nonce1),
          },
          { status: 401 },
        );
      }
      const capability = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as { authorization: { nonce: string } };
      if (capability.authorization.nonce === nonce1) {
        return Response.json(
          {
            error: "audience_proof_rejected",
            capabilityChallenge: challenge(nonce2),
          },
          { status: 403 },
        );
      }
      expect(capability.authorization.nonce).toBe(nonce2);
      return new Response(pdf, {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="formation.pdf"',
        },
      });
    };
    const gateway = await startTestGateway({ a2aFetch });
    gateways.push(gateway);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const first = parseResult<{
        authorization: Record<string, unknown>;
        eip712TypedData: { primaryType: string };
      }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: { url: artifactUrl, taskId },
        }),
      );
      expect(first.eip712TypedData.primaryType).toBe("TaskAccessAuthorization");

      const refreshed = parseResult<{
        authorization: { nonce: string };
        hint: string;
      }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: {
            url: artifactUrl,
            taskId,
            capability: {
              signature: `0x${"ab".repeat(65)}`,
              authorization: first.authorization,
            },
          },
        }),
      );
      expect(refreshed.authorization.nonce).toBe(nonce2);
      expect(refreshed.hint).toContain("fresh");

      const fetched = parseResult<{
        artifact: {
          bytesBase64: string;
          mimeType: string;
          filename: string;
          sizeBytes: number;
          sha256: string;
        };
      }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: {
            url: artifactUrl,
            taskId,
            capability: {
              signature: `0x${"cd".repeat(65)}`,
              authorization: refreshed.authorization,
            },
          },
        }),
      );
      expect(Buffer.from(fetched.artifact.bytesBase64, "base64")).toEqual(
        Buffer.from(pdf),
      );
      expect(fetched.artifact).toMatchObject({
        mimeType: "application/pdf",
        filename: "formation.pdf",
        sizeBytes: pdf.byteLength,
      });
      expect(fetched.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(calls).toBe(3);
    } finally {
      await transport.close();
    }
  });

  it("preserves inline FilePart bytes from task status", async () => {
    const bytes = Buffer.from("%PDF-1.7\ninline").toString("base64");
    const gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Formation Provider",
          priceUsdcSmallest: "1000000",
          categoryFamily: "business-formation",
          serviceType: "entity-formation",
        },
      ],
      initialTaskState: {
        id: "task-inline-file",
        state: "completed",
        artifacts: [
          {
            name: "formation_document",
            parts: [
              {
                type: "file",
                file: {
                  bytes,
                  name: "formation.pdf",
                  mimeType: "application/pdf",
                },
              },
            ],
          },
        ],
      },
    });
    gateways.push(gateway);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ artifacts: Array<Record<string, unknown>> }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            taskId: "task-inline-file",
          },
        }),
      );
      expect(result.artifacts).toEqual([
        {
          type: "file",
          name: "formation_document",
          bytes,
          encoding: "base64",
          mimeType: "application/pdf",
        },
      ]);
    } finally {
      await transport.close();
    }
  });
});
