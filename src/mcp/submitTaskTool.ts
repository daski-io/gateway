import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import type { McpToolResult } from "./util.js";

const INPUT_SCHEMA = {
  providerA2AUrl: z.string(),
  skillId: z.string(),
  paymentId: z.string().describe(
    "Decimal paymentId returned by daski_buy_service. Use 0 only for " +
      "open free skills; gated free skills use the original asset paymentId.",
  ),
  chainId: z.union([z.literal(8453), z.literal(84532)]).describe(
    "Base chain ID: 8453 for mainnet or 84532 for Sepolia.",
  ),
  buyerTokenId: z.string().optional().describe(
    "Buyer agentId. Optional when walletAddress can resolve it on chain.",
  ),
  walletAddress: z.string().optional().describe(
    "Buyer wallet used to resolve buyerTokenId for an authenticated task.",
  ),
  serviceRef: z.string().optional().describe(
    "32-byte serviceRef returned by settlement; required for paid tasks.",
  ),
  transactionHash: z.string().optional().describe(
    "Settlement transaction hash; required for paid tasks.",
  ),
  prompt: z.string().optional(),
  serviceArgs: z.record(z.string(), z.unknown()).optional(),
  capability: z
    .object({
      signature: z.string(),
      authorization: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .optional(),
  messageId: z.string().optional().describe(
    "Required with envelopeAuth; echo the first call's messageId.",
  ),
  envelopeAuth: z
    .object({
      signature: z.string(),
      authorization: z
        .object({
          buyerTokenId: z.string(),
          skillId: z.string(),
          paymentId: z.string(),
          chainId: z.number(),
          messageId: z.string(),
          requestHash: z.string(),
          issuedAt: z.string(),
        })
        .passthrough(),
    })
    .passthrough()
    .optional()
    .describe(
      "Omit on the first authenticated call. On retry, pass the signed " +
        "authorization and matching messageId without changing serviceArgs.",
    ),
  contextId: z.string().optional().describe(
    "A2A contextId for continuing a prior conversation.",
  ),
  taskId: z.string().optional().describe(
    "Only for answering a long-running input-required task. Do not combine " +
      "with paid routing fields or envelopeAuth.",
  ),
};

const DESCRIPTION = [
  "Dispatch a task to a Daski provider over A2A. Use for free skills and after daski_buy_service for paid skills.",
  "",
  "Open free skills use paymentId \"0\" and complete synchronously.",
  "Paid and gated-free skills use a two-call envelope handshake. The signed",
  "retry must preserve the exact serviceArgs, messageId, and paid routing",
  "fields returned by settlement, with NOTHING REMOVED.",
  "",
  "For a long-running task in input-required state, pass taskId and the full",
  "corrected serviceArgs without serviceRef, transactionHash, or envelopeAuth.",
  "Capability-gated write resubmissions instead keep contextId and must not",
  "set taskId.",
  "",
  "Returns signing material on the first authenticated call. Otherwise returns",
  "taskId, contextId, state, artifacts, and statusMessage. Poll non-terminal",
  "tasks with daski_get_task_status.",
].join("\n");

export function registerSubmitTaskTool(
  server: McpServer,
  handler: (args: SubmitTaskArgs) => Promise<McpToolResult>,
): void {
  server.registerTool(
    "daski_submit_task",
    {
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      annotations: {
        title: "Run a Daski task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler,
  );
}
