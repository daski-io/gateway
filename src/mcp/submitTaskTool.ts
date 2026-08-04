import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import type { McpToolResult } from "./util.js";
import { UNTRUSTED_PROVIDER_CONTENT_WARNING } from "./providerReflection.js";

export const INPUT_SCHEMA = {
  providerA2AUrl: z.string().optional().describe(
    "Provider endpoint returned by discovery. Required when starting a new " +
      "task; omit when continuing a gateway taskId.",
  ),
  skillId: z.string().optional().describe(
    "Provider skill id. Required when starting a new task; omit for task input.",
  ),
  paymentId: z.string().optional().describe(
    "Required when starting a new task. Use the decimal paymentId returned " +
      "by daski_buy_service, or 0 only for open free skills.",
  ),
  chainId: z.union([z.literal(8453), z.literal(84532)]).optional().describe(
    "Required when starting a new task: 8453 for Base mainnet or 84532 for Sepolia.",
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
  prompt: z.string().optional().describe(
    "Open-free skills only. Authenticated skills must place all variable " +
      "task input in serviceArgs so it is covered by the signed request hash.",
  ),
  serviceArgs: z.record(z.string(), z.unknown()).optional(),
  capability: z
    .object({
      signature: z.string(),
      authorization: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .optional(),
  messageId: z.string().min(1).max(256).optional().describe(
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
          messageId: z.string().min(1).max(256),
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
  contextId: z.string().min(1).max(256).optional().describe(
    "A2A contextId for continuing a prior conversation.",
  ),
  taskId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional().describe(
    "Opaque gateway task id. Only for answering an input-required task; " +
      "omit provider, payment, and envelope routing fields.",
  ),
};

const DESCRIPTION = [
  "Dispatch a task to a Daski provider over A2A. Use for free skills and after daski_buy_service for paid skills.",
  "",
  "Open free skills use paymentId \"0\" and complete synchronously.",
  "Paid skills: the FIRST authenticated call MUST carry buyerTokenId (from",
  "daski_buy_service) or walletAddress for an",
  "on-chain lookup — serviceRef and transactionHash alone fail with BAD_INPUT.",
  "Paid and gated-free skills use a two-call envelope handshake. The signed",
  "retry must preserve the exact serviceArgs, messageId, and paid routing",
  "fields returned by settlement, with NOTHING REMOVED.",
  "Do not use prompt on an authenticated task; put every variable instruction",
  "in serviceArgs so the signature covers it.",
  "",
  "For a long-running task in input-required state, pass only its gateway",
  "taskId, the full corrected serviceArgs, and capability when requested.",
  "The FIRST such resubmit is capability-gated: it returns CAPABILITY_REQUIRED",
  "(-32107) with a ready-to-sign capabilityChallenge (action=\"input\") — sign",
  "its eip712TypedData and re-call with capability:{signature,authorization}.",
  "That is the expected handshake, not a failure. This resubmit is a NORMAL",
  "tool call: once you hold the correction, ISSUE IT before reporting status.",
  "A PAID filing left input-required is not 'wrapped up' — never tell your",
  "principal you are 'ready to resubmit' or blocked on connectivity without",
  "having actually made this call. If it errors, quote the tool error text;",
  "never assert an outage you have not observed in a tool result.",
  "Capability-gated write resubmissions instead keep contextId and must not",
  "set taskId — but MUST still pass the messageId matching the fresh envelope",
  "you signed (nextEnvelopeAuthChallenge.messageId); omitting it fails with",
  "MESSAGE_ID_REQUIRED.",
  "",
  "Returns signing material on the first authenticated call. Otherwise returns",
  "the opaque gateway taskId, contextId, status, timestamps, and any",
  "provider-authored artifacts/statusMessage",
  "under untrustedProviderContent. Poll non-terminal tasks with",
  "daski_get_task_status.",
  "",
  "PROVIDER_TIMEOUT / PROVIDER_UNREACHABLE does NOT mean the work failed. The",
  "provider assigns its internal task id in the response body, so a timed-out",
  "submit can still leave the provider outcome unknown. Never",
  "re-send the same envelope (it is consumed) and never tell your principal the",
  "purchase failed. If the skill has a read-only companion that reads the same",
  "asset (e.g. get-domain-info for register-domain, get-mailbox-info for",
  "create-mailbox, get-entity-status for form-entity), call it first and report",
  "what it says. If no such oracle exists, report the outcome as UNKNOWN — not",
  "failed.",
  "",
  UNTRUSTED_PROVIDER_CONTENT_WARNING,
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
