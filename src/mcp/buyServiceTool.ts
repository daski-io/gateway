import {
  type McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const INPUT_SCHEMA = {
  skillId: z.string(),
  serviceSlug: z.string().describe(
    "Service identifier returned by daski_search_services.",
  ),
  walletAddress: z.string().describe(
    "Wallet that signs payment and any atomic registration.",
  ),
  name: z.string().optional().describe(
    "Registration-time display name for a fresh wallet.",
  ),
  buyerTokenId: z.string().optional().describe(
    "Buyer agentId. The gateway resolves it from walletAddress when omitted.",
  ),
  providerTokenId: z.string().describe(
    "Provider agentId returned by daski_search_services.",
  ),
  serviceArgs: z.record(z.string(), z.unknown()).optional().describe(
    "Skill-specific fields advertised by the selected catalog skill.",
  ),
  phoneAcknowledgementToken: z.string().optional().describe(
    "Acknowledgement token returned when serviceArgs contain phone values.",
  ),
  amount: z.string().optional().describe(
    "Optional buyer spend cap; provider pricing still comes from a signed quote.",
  ),
  paymentId: z.string().optional().describe(
    "Original asset paymentId for a free ownership-gated skill.",
  ),
  paymentPayload: z
    .object({
      x402Version: z.literal(1),
      scheme: z.literal("exact"),
      network: z.enum(["base", "base-sepolia"]),
      payload: z.object({
        signature: z.string(),
        authorization: z.record(z.string(), z.unknown()),
      }),
    })
    .passthrough()
    .optional()
    .describe("Signed payment payload for the settlement retry."),
  paymentRequirements: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Original payment requirements echoed on the signed retry."),
  registration: z
    .object({
      agentURI: z.string(),
      deadline: z.string(),
      signature: z.string(),
    })
    .optional()
    .describe("Atomic registration authorization for a fresh wallet."),
};

const DESCRIPTION = [
  "Start here for a paid Daski service. The first call validates service",
  "arguments and returns a signed provider quote plus payment typed data.",
  "The second call echoes those inputs with paymentPayload,",
  "paymentRequirements, and registration when the wallet is fresh.",
  "Entity-formation managementType and members/managers are TOP-LEVEL `serviceArgs` keys.",
  "There is NO `officials` or `officialsByClassification` wrapper.",
  "",
  "Settlement and task dispatch are separate: after a successful second call,",
  "call daski_submit_task with the returned paymentId, serviceRef,",
  "transactionHash, providerA2AUrl, and buyerTokenId.",
  "",
  "The Operator is the legal party. Payment authorization after the final",
  "purchase notice binds the Operator to the linked marketplace and provider",
  "terms.",
].join("\n");

export function registerBuyServiceTool(
  server: McpServer,
  handler: ToolCallback<typeof INPUT_SCHEMA>,
): void {
  server.registerTool(
    "daski_buy_service",
    {
      description: DESCRIPTION,
      inputSchema: INPUT_SCHEMA,
      annotations: {
        title: "Buy a Daski service",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler,
  );
}
