import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { parseFilename } from "../src/mcp/artifactProtocol.js";

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
        resource: artifactUrl,
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
    const gateway = await startTestGateway({
      a2aFetch,
      providers: [artifactProvider()],
    });
    gateways.push(gateway);
    const providerA2AUrl = `${gateway.mockProvider.baseUrl}/a2a`;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const first = parseResult<{
        authorization: Record<string, unknown>;
        eip712TypedData: { primaryType: string };
      }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: { url: artifactUrl, taskId, providerA2AUrl },
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
            providerA2AUrl,
            capability: {
              signature: `0x${"ab".repeat(65)}`,
              authorization: first.authorization,
            },
          },
        }),
      );
      expect(refreshed.authorization.nonce).toBe(nonce2);
      expect(refreshed.hint).toContain("fresh");

      const fetchedResult = await client.callTool({
        name: "daski_fetch_artifact",
        arguments: {
          url: artifactUrl,
          taskId,
          providerA2AUrl,
          capability: {
            signature: `0x${"cd".repeat(65)}`,
            authorization: refreshed.authorization,
          },
        },
      });
      const fetched = parseResult<{
        artifact: {
          mimeType: string;
          filename: string;
          sizeBytes: number;
          sha256: string;
        };
      }>(fetchedResult);
      expect(fetched.artifact).toMatchObject({
        mimeType: "application/pdf",
        filename: "formation.pdf",
        sizeBytes: pdf.byteLength,
      });
      expect(fetched.artifact).not.toHaveProperty("bytesBase64");
      expect(fetched.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      const resource = (fetchedResult.content as Array<any>).find(
        (entry) => entry.type === "resource",
      );
      expect(Buffer.from(resource.resource.blob, "base64")).toEqual(Buffer.from(pdf));
      expect(calls).toBe(3);
    } finally {
      await transport.close();
    }
  });

  it("rejects an artifact challenge that is not bound to the exact URL", async () => {
    const requestedUrl = "https://artifacts.example/requested.pdf";
    const a2aFetch: typeof fetch = async () =>
      Response.json(
        {
          capabilityChallenge: {
            authorization: {
              taskId: "task-document-2",
              action: "document-download",
              resource: "https://artifacts.example/different.pdf",
            },
            eip712TypedData: {
              primaryType: "TaskAccessAuthorization",
            },
          },
        },
        { status: 401 },
      );
    const gateway = await startTestGateway({
      a2aFetch,
      providers: [artifactProvider()],
    });
    gateways.push(gateway);
    const providerA2AUrl = `${gateway.mockProvider.baseUrl}/a2a`;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_fetch_artifact",
        arguments: {
          url: requestedUrl,
          taskId: "task-document-2",
          providerA2AUrl,
        },
      });
      const body = parseResult<{ code: string }>(result);
      expect(body.code).toBe("ARTIFACT_CHALLENGE_MISMATCH");
    } finally {
      await transport.close();
    }
  });

  it("accepts a TaskAccess-shaped challenge with no resource binding", async () => {
    // Provider document challenges are TaskAccessChallenges — authorization
    // binds (buyerTokenId, taskId, action, nonce, expiry) and carries NO
    // resource field. Demanding one rejected every real download
    // (agentic run 260723-163533).
    const requestedUrl = "https://artifacts.example/requested.pdf";
    const a2aFetch: typeof fetch = async () =>
      Response.json(
        {
          capabilityChallenge: {
            authorization: {
              buyerTokenId: "8360",
              taskId: "task-document-3",
              action: "document-download",
              nonce: `0x${"11".repeat(32)}`,
              expiry: "1784819678",
            },
            eip712TypedData: {
              primaryType: "TaskAccessAuthorization",
            },
          },
        },
        { status: 401 },
      );
    const gateway = await startTestGateway({
      a2aFetch,
      providers: [artifactProvider()],
    });
    gateways.push(gateway);
    const providerA2AUrl = `${gateway.mockProvider.baseUrl}/a2a`;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_fetch_artifact",
        arguments: {
          url: requestedUrl,
          taskId: "task-document-3",
          providerA2AUrl,
        },
      });
      const body = parseResult<{
        requiresSignature?: boolean;
        authorization?: { taskId?: string };
      }>(result);
      expect(body.requiresSignature).toBe(true);
      expect(body.authorization?.taskId).toBe("task-document-3");
    } finally {
      await transport.close();
    }
  });

  it("names the bound taskId when the challenge belongs to a different task", async () => {
    const requestedUrl = "https://artifacts.example/requested.pdf";
    const a2aFetch: typeof fetch = async () =>
      Response.json(
        {
          capabilityChallenge: {
            authorization: {
              taskId: "task-document-minter",
              action: "document-download",
            },
            eip712TypedData: {
              primaryType: "TaskAccessAuthorization",
            },
          },
        },
        { status: 401 },
      );
    const gateway = await startTestGateway({
      a2aFetch,
      providers: [artifactProvider()],
    });
    gateways.push(gateway);
    const providerA2AUrl = `${gateway.mockProvider.baseUrl}/a2a`;
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_fetch_artifact",
        arguments: {
          url: requestedUrl,
          taskId: "task-wrong",
          providerA2AUrl,
        },
      });
      const body = parseResult<{ code: string; message: string }>(result);
      expect(body.code).toBe("ARTIFACT_CHALLENGE_MISMATCH");
      expect(body.message).toContain("task-document-minter");
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
    const mappingId = await gateway.bundle.queries.insertTaskMapping({
      contextId: "ctx-inline-file",
      messageId: "msg-inline-file",
      serviceRef: null,
      providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
      skillId: "form-entity",
      buyerTokenId: "0",
    });
    await gateway.bundle.queries.completeTaskMapping(
      mappingId,
      "task-inline-file",
      "completed",
    );
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{
        untrustedProviderContent: {
          artifacts: Array<Record<string, unknown>>;
        };
      }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            providerA2AUrl: gateway.mockProvider.baseUrl + "/a2a",
            taskId: "task-inline-file",
            taskAccessToken: "t".repeat(43),
          },
        }),
      );
      expect(result.untrustedProviderContent.artifacts).toEqual([
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

  it("rejects artifact origins that the provider did not advertise", async () => {
    const a2aFetch = vi.fn<typeof fetch>();
    const gateway = await startTestGateway({
      a2aFetch,
      providers: [artifactProvider([])],
    });
    gateways.push(gateway);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_fetch_artifact",
          arguments: {
            url: "https://unrelated.example/document.pdf",
            taskId: "task-untrusted-origin",
            providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
          },
        }),
      );
      expect(result.code).toBe("ARTIFACT_ENDPOINT_NOT_CATALOGED");
      expect(a2aFetch).not.toHaveBeenCalled();
    } finally {
      await transport.close();
    }
  });
});

function artifactProvider(artifactOrigins = ["https://artifacts.example"]) {
  return {
    tokenId: 1n,
    name: "Formation Provider",
    priceUsdcSmallest: "1000000",
    categoryFamily: "business-formation" as const,
    serviceType: "entity-formation" as const,
    artifactOrigins,
  };
}

describe("artifact filename parsing", () => {
  it("removes path traversal, reserved names, and control characters", () => {
    expect(parseFilename('attachment; filename="../../formation.pdf"')).toBe(
      "formation.pdf",
    );
    expect(parseFilename('attachment; filename="CON.txt"')).toBe("_CON.txt");
    expect(parseFilename("attachment; filename*=UTF-8''..%2Fsecret%00.pdf")).toBe(
      "secret_.pdf",
    );
  });
});
