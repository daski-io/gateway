import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runConfirmDelivery } from "../payment/confirm.js";
import { prepareConfirmation } from "../payment/confirmationPrep.js";
import type { McpDeps } from "./server.js";
import { mcpError, mcpJson, type McpToolResult } from "./util.js";

interface ConfirmDeliveryArgs {
  paymentId: string;
  confirmation: "Confirmed" | "NotConfirmed";
  attester: string;
  deadlineSeconds?: number;
  deadline?: string;
  refUid?: string;
  signature?: { v: number; r: string; s: string };
}

export function registerConfirmDeliveryTool(
  server: McpServer,
  deps: McpDeps,
): void {
  server.registerTool(
    "daski_confirm_delivery",
    {
      description: [
        "Leave a confirmed or not-confirmed attestation for a completed purchase.",
        "The gateway relays the signed EAS attestation and updates the provider's on-chain reputation.",
        "",
        "First call without signature returns EIP-712 typed-data and a deadline.",
        "Second call repeats the inputs with deadline and signature {v,r,s}.",
        "Use the same buyer wallet that paid for the service.",
      ].join("\n"),
      inputSchema: {
        paymentId: z
          .string()
          .describe("On-chain payment identifier returned at settlement."),
        confirmation: z.enum(["Confirmed", "NotConfirmed"]),
        attester: z
          .string()
          .describe("Buyer wallet that paid for the service."),
        deadlineSeconds: z
          .number()
          .optional()
          .describe("First-call signature expiry. Default 3600 seconds."),
        deadline: z
          .string()
          .optional()
          .describe("Second-call deadline returned by the first call."),
        refUid: z.string().optional(),
        signature: z
          .object({
            v: z.number(),
            r: z.string(),
            s: z.string(),
          })
          .optional(),
      },
      annotations: {
        title: "Confirm Daski delivery",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args: ConfirmDeliveryArgs): Promise<McpToolResult> =>
      confirmDelivery(args, deps),
  );
}

async function confirmDelivery(
  args: ConfirmDeliveryArgs,
  deps: McpDeps,
): Promise<McpToolResult> {
  if (!args.signature) {
    const prepared = await prepareConfirmation(
      { config: deps.config, reader: deps.reader },
      {
        paymentId: args.paymentId,
        confirmation: args.confirmation,
        attester: args.attester,
        deadlineSeconds: args.deadlineSeconds,
        refUid: args.refUid,
      },
    );
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
  if (!args.deadline) {
    return mcpError({
      code: "BAD_INPUT",
      message:
        "deadline is required alongside signature. Echo the value from " +
        "the first call so the signed typed-data matches.",
    });
  }
  const result = await runConfirmDelivery(
    { config: deps.config, reader: deps.reader, queries: deps.queries },
    args.paymentId,
    {
      confirmation: args.confirmation,
      attester: args.attester,
      deadline: args.deadline,
      refUid: args.refUid,
      signature: args.signature,
    },
  );
  if (!result.ok) return mcpError(result.error);
  const { ok: _ok, ...response } = result;
  return mcpJson(response);
}
