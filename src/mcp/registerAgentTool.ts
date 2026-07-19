import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  prepareRegistration,
  submitRegistration,
} from "../identity/service.js";
import type { McpDeps } from "./server.js";
import { mcpError, mcpJson, type McpToolResult } from "./util.js";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface RegisterAgentArgs {
  walletAddress: string;
  name?: string;
  agentURI?: string;
  deadline?: string;
  deadlineSeconds?: number;
  signature?: string;
}

export function registerAgentTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "daski_register_agent",
    {
      description: [
        "**Advanced.** Register a wallet as an ERC-8004 Daski agent without making a purchase.",
        "Most buyers should use daski_buy_service, which registers fresh wallets atomically.",
        "",
        "First call with walletAddress and optional name or agentURI returns EIP-712 typed-data.",
        "Second call repeats walletAddress with the returned agentURI, deadline, and wallet signature.",
      ].join("\n"),
      inputSchema: {
        walletAddress: z
          .string()
          .describe("Exact wallet address that will sign the typed-data."),
        name: z
          .string()
          .optional()
          .describe("First-call display name, mutually exclusive with agentURI."),
        agentURI: z
          .string()
          .optional()
          .describe("Custom first-call URI or exact URI returned for the second call."),
        deadlineSeconds: z
          .number()
          .optional()
          .describe("First-call signature expiry. Default 3600 seconds."),
        deadline: z
          .string()
          .optional()
          .describe("Second-call deadline returned by the first call."),
        signature: z
          .string()
          .optional()
          .describe("Second-call signTypedData signature."),
      },
      annotations: {
        title: "Register a Daski agent",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args: RegisterAgentArgs): Promise<McpToolResult> =>
      registerAgent(args, deps),
  );
}

async function registerAgent(
  args: RegisterAgentArgs,
  deps: McpDeps,
): Promise<McpToolResult> {
  if (!HEX_ADDRESS.test(args.walletAddress)) {
    return mcpError({
      code: "BAD_WALLET",
      message: "walletAddress must be a 20-byte hex address",
    });
  }
  const identityDeps = {
    config: deps.config,
    reader: deps.reader,
    queries: deps.queries,
    fetchAgentCardFn: deps.buyerAgentCardFetch,
  };
  if (!args.signature) {
    const prepared = await prepareRegistration(identityDeps, {
      walletAddress: args.walletAddress,
      name: args.name,
      agentURI: args.agentURI,
      deadlineSeconds: args.deadlineSeconds,
    });
    if (!prepared.ok) {
      const { code, message, ...details } = prepared.error;
      return mcpError({
        code,
        message,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      });
    }
    return mcpJson(prepared.value);
  }
  if (!args.agentURI || !args.deadline) {
    return mcpError({
      code: "BAD_INPUT",
      message:
        "agentURI and deadline are required alongside signature. Echo the " +
        "values returned by the first call.",
    });
  }
  const submitted = await submitRegistration(identityDeps, {
    walletAddress: args.walletAddress,
    agentURI: args.agentURI,
    deadline: args.deadline,
    signature: args.signature,
  });
  if (!submitted.ok) {
    const { code, message, ...details } = submitted.error;
    return mcpError({
      code,
      message,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
  }
  return mcpJson(submitted.value);
}
