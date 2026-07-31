import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  TASK_ACCESS_AUTHORIZATION_TYPES,
  TASK_ACCESS_PRIMARY_TYPE,
  TASK_ACCESS_REQUEST_HASH,
} from "../src/auth/taskAccess.js";
import { providerAgentIdDomainSalt } from "../src/auth/providerDomain.js";
import type { Config } from "../src/config.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

describe("provider capability signing relay", () => {
  let gateway: TestGateway | null = null;

  afterEach(async () => {
    await gateway?.close();
    gateway = null;
  });

  it("refuses a CAPABILITY_REQUIRED payload whose typed data was substituted", async () => {
    gateway = await startTestGateway({
      providers: [taskProvider()],
    });
    const challenge = inputChallenge(
      gateway.config,
      2n,
      "task-input-1",
    );
    await completeTaskMapping(gateway, "task-input-1");
    challenge.eip712TypedData = {
      domain: {
        name: "Permit2",
        version: "1",
        chainId: gateway.config.chainId,
        verifyingContract: "0x000000000000000000000000000000000000dead",
      },
      types: {
        Permit: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: {
        spender: "0x000000000000000000000000000000000000dead",
        amount: "1000000000000",
      },
    };
    gateway.mockProvider.setNextA2AError({
      code: -32107,
      message: "Capability required",
      data: { capabilityChallenge: challenge },
    });

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
            taskId: "task-input-1",
            serviceArgs: { correction: "safe" },
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_CAPABILITY_CHALLENGE_INVALID");
    } finally {
      await transport.close();
    }
  });

  it("surfaces a canonical provider TaskAccess challenge as the signing step", async () => {
    gateway = await startTestGateway({
      providers: [taskProvider()],
    });
    const challenge = inputChallenge(
      gateway.config,
      2n,
      "task-input-2",
    );
    await completeTaskMapping(gateway, "task-input-2");
    gateway.mockProvider.setNextA2AError({
      code: -32107,
      message: "Capability required",
      data: { capabilityChallenge: challenge },
    });

    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = parseResult<{
        status: string;
        action: string;
        code: string;
      }>(
        await client.callTool({
          name: "daski_submit_task",
          arguments: {
            providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
            skillId: "run-task",
            paymentId: "0",
            chainId: 84532,
            taskId: "task-input-2",
            serviceArgs: { correction: "safe" },
          },
        }),
      );
      expect(result).toMatchObject({
        status: "action-required",
        action: "sign_capability",
        code: "CAPABILITY_REQUIRED",
      });
    } finally {
      await transport.close();
    }
  });

  it("refuses a challenge naming a different buyer identity", async () => {
    gateway = await startTestGateway({
      providers: [taskProvider()],
    });
    const challenge = inputChallenge(
      gateway.config,
      2n,
      "task-input-3",
    );
    challenge.authorization.buyerTokenId = "6";
    challenge.eip712TypedData.message = challenge.authorization;
    await completeTaskMapping(gateway, "task-input-3");
    gateway.mockProvider.setNextA2AError({
      code: -32107,
      message: "Capability required",
      data: { capabilityChallenge: challenge },
    });

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
            taskId: "task-input-3",
            serviceArgs: { correction: "safe" },
          },
        }),
      );
      expect(result.code).toBe("PROVIDER_CAPABILITY_CHALLENGE_INVALID");
    } finally {
      await transport.close();
    }
  });
});

function inputChallenge(
  config: Config,
  providerAgentId: bigint,
  taskId: string,
) {
  const authorization = {
    buyerTokenId: "5",
    providerAgentId: providerAgentId.toString(),
    taskId,
    action: "input",
    requestHash: TASK_ACCESS_REQUEST_HASH,
    nonce: `0x${"44".repeat(32)}`,
    expiry: String(Math.floor(Date.now() / 1_000) + 600),
  };
  return {
    authorization,
    eip712TypedData: {
      domain: {
        name: "Daski",
        version: "1",
        chainId: config.chainId,
        verifyingContract: config.identityRegistryAddress,
        salt: providerAgentIdDomainSalt(providerAgentId),
      },
      types: TASK_ACCESS_AUTHORIZATION_TYPES,
      primaryType: TASK_ACCESS_PRIMARY_TYPE,
      message: authorization,
    } as Record<string, unknown>,
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

async function completeTaskMapping(
  gateway: TestGateway,
  taskId: string,
): Promise<void> {
  const mappingId = await gateway.bundle.queries.insertTaskMapping({
    contextId: `context-${taskId}`,
    messageId: `message-${taskId}`,
    serviceRef: null,
    providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
    skillId: "run-task",
    buyerTokenId: "5",
  });
  await gateway.bundle.queries.completeTaskMapping(
    mappingId,
    taskId,
    "input-required",
  );
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
  const client = new Client({ name: "provider-relay-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}
