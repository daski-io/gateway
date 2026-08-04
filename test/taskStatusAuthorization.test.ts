import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  TASK_ACCESS_AUTHORIZATION_TYPES,
  TASK_ACCESS_PRIMARY_TYPE,
  TASK_ACCESS_REQUEST_HASH,
} from "../src/auth/taskAccess.js";
import {
  startTestGateway,
  TEST_BUYER_KEY,
  type TestGateway,
} from "./helpers/setup.js";
import taskAccessVector from "./vectors/task-access.json";

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
}

function parseResult<T>(result: unknown): T {
  const content = (result as ToolResultContent).content;
  return JSON.parse(content[0]!.text) as T;
}

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = new Client({ name: "task-access-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("task-status authorization admission", () => {
  let gateway: TestGateway;
  let getTaskBodies: Array<Record<string, unknown>>;

  beforeEach(async () => {
    getTaskBodies = [];
    const observedFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (body.method === "GetTask") getTaskBodies.push(body);
      }
      return fetch(input, init);
    };
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Task Provider",
          priceUsdcSmallest: "0",
          categoryFamily: "other",
          serviceType: "other",
          skills: [{ id: "run-task" }],
        },
      ],
      initialTaskState: {
        id: "buyer-task",
        state: "completed",
        message: {
          role: "agent",
          parts: [{ type: "text", text: "done" }],
        },
      },
      a2aFetch: observedFetch,
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("challenges and verifies the current buyer controller before polling", async () => {
    expect(TASK_ACCESS_REQUEST_HASH).toBe(
      taskAccessVector.authorization.requestHash,
    );
    expect(TASK_ACCESS_AUTHORIZATION_TYPES).toEqual(taskAccessVector.types);
    expect(TASK_ACCESS_PRIMARY_TYPE).toBe(taskAccessVector.primaryType);
    expect(
      await recoverTypedDataAddress({
        domain: {
          ...taskAccessVector.domain,
          verifyingContract:
            taskAccessVector.domain.verifyingContract as `0x${string}`,
          salt: taskAccessVector.domain.salt as `0x${string}`,
        },
        types: TASK_ACCESS_AUTHORIZATION_TYPES,
        primaryType: TASK_ACCESS_PRIMARY_TYPE,
        message: {
          ...taskAccessVector.authorization,
          buyerTokenId: BigInt(
            taskAccessVector.authorization.buyerTokenId,
          ),
          providerAgentId: BigInt(
            taskAccessVector.authorization.providerAgentId,
          ),
          expiry: BigInt(taskAccessVector.authorization.expiry),
          requestHash:
            taskAccessVector.authorization.requestHash as `0x${string}`,
          nonce: taskAccessVector.authorization.nonce as `0x${string}`,
        },
        signature: taskAccessVector.signature as `0x${string}`,
      }),
    ).toBe(taskAccessVector.signer);
    const providerA2AUrl = `${gateway.mockProvider.url}/a2a`;
    const pending = await gateway.tasks.begin({
      contextId: "buyer-context",
      messageId: "buyer-message",
      serviceRef: null,
      providerA2AUrl,
      skillId: "run-task",
      buyerTokenId: "5",
    });
    await gateway.tasks.complete(
      pending.mappingId,
      "buyer-task",
      "completed",
    );

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const challenge = parseResult<{
        code: string;
        authorization: Record<string, unknown>;
        eip712TypedData: {
          domain: Record<string, unknown>;
          types: Record<string, Array<{ name: string; type: string }>>;
          primaryType: string;
          message: Record<string, unknown>;
        };
      }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            taskId: pending.taskId,
          },
        }),
      );
      expect(challenge.code).toBe("TASK_AUTHORIZATION_REQUIRED");
      expect(challenge.authorization.providerAgentId).toBe("2");
      expect(getTaskBodies).toHaveLength(0);

      const account = privateKeyToAccount(TEST_BUYER_KEY);
      const signature = await account.signTypedData(
        challenge.eip712TypedData as Parameters<
          typeof account.signTypedData
        >[0],
      );
      const result = parseResult<{ taskId: string; status: string }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            taskId: pending.taskId,
            capability: {
              signature,
              authorization: challenge.authorization,
            },
          },
        }),
      );
      expect(result).toMatchObject({
        taskId: pending.taskId,
        status: "completed",
      });
      expect(getTaskBodies).toHaveLength(1);
    } finally {
      await transport.close();
    }
  });

  it("does no outbound request for an unmapped task", async () => {
    const unknownTaskId = "n".repeat(43);
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            taskId: unknownTaskId,
          },
        }),
      );
      expect(result.code).toBe("TASK_NOT_FOUND");
      expect(getTaskBodies).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });

  it("requires and forwards the anonymous task token", async () => {
    const providerA2AUrl = `${gateway.mockProvider.url}/a2a`;
    const pending = await gateway.tasks.begin({
      contextId: "anonymous-context",
      messageId: "anonymous-message",
      serviceRef: null,
      providerA2AUrl,
      skillId: "run-task",
      buyerTokenId: "0",
    });
    await gateway.tasks.complete(
      pending.mappingId,
      "anonymous-task",
      "working",
    );

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const missing = parseResult<{ code: string }>(
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            taskId: pending.taskId,
          },
        }),
      );
      expect(missing.code).toBe("TASK_ACCESS_TOKEN_REQUIRED");
      expect(getTaskBodies).toHaveLength(0);

      const taskAccessToken = "A".repeat(43);
      await client.callTool({
        name: "daski_get_task_status",
        arguments: {
          taskId: pending.taskId,
          taskAccessToken,
        },
      });
      expect(getTaskBodies).toHaveLength(1);
      expect(getTaskBodies[0]).toMatchObject({
        method: "GetTask",
        params: { id: "anonymous-task", taskAccessToken },
      });
    } finally {
      await transport.close();
    }
  });
});
