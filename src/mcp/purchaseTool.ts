import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hex } from "../types.js";
import { createQuotedChallenge } from "../payment/quotedChallenge.js";
import type { Fetcher } from "./a2a.js";
import type { McpDeps } from "./server.js";
import { isHexAddress } from "../util/evmValidation.js";
import {
  mcpError,
  mcpJson,
  parseBigIntArg,
  type McpToolResult,
} from "./util.js";

export interface PurchaseToolTransport {
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

export function registerPurchaseTool(
  server: McpServer,
  deps: McpDeps,
  transport: PurchaseToolTransport,
): void {
  server.registerTool(
    "daski_purchase",
    {
      description: [
        "**Advanced/manual.** Prefer `daski_buy_service` unless you're managing the payment lifecycle yourself.",
        "",
        "Open an x402 payment challenge for a provider and skill. Returns payment requirements with EIP-712 typed-data to sign.",
        "Your Operator is the legal party. Payment authorization after the final purchase notice binds the Operator to the linked Daski and Provider Terms.",
        "Use this to separate quoting from settlement or to build a custom UI.",
        "Next: sign the typed-data and call daski_settle_payment.",
      ].join("\n"),
      inputSchema: {
        providerTokenId: z.string(),
        serviceSlug: z.string(),
        buyerTokenId: z.string().describe("Buyer's ERC-8004 agentId."),
        walletAddress: z
          .string()
          .describe("The exact wallet address that will sign the typed-data."),
        skillId: z.string(),
        serviceArgs: z.record(z.string(), z.unknown()).optional(),
        amount: z
          .string()
          .optional()
          .describe("Maximum price in atomic USDC units."),
      },
      annotations: {
        title: "Daski: open payment challenge",
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<McpToolResult> => {
      if (!isHexAddress(args.walletAddress)) {
        return mcpError({
          code: "BAD_INPUT",
          message: "walletAddress must be a 20-byte hex address",
        });
      }
      const provider = parseBigIntArg(
        args.providerTokenId,
        "providerTokenId",
      );
      if (!provider.ok) return provider.error;
      const buyer = parseBigIntArg(args.buyerTokenId, "buyerTokenId");
      if (!buyer.ok) return buyer.error;

      const result = await createQuotedChallenge(
        {
          providerAgentId: provider.value,
          buyerAgentId: buyer.value,
          walletAddress: args.walletAddress.toLowerCase() as Hex,
          skillId: args.skillId,
          serviceSlug: args.serviceSlug,
          serviceArgs: args.serviceArgs ?? {},
          amountLimit: args.amount,
        },
        {
          config: deps.config,
          cache: deps.cache,
          queries: deps.queries,
          reader: deps.reader,
          fetch: transport.fetch,
          timeoutMs: transport.timeoutMs,
          maxResponseBytes: transport.maxResponseBytes,
        },
      );
      if (!result.ok) {
        return mcpError({
          code: result.error.code,
          message: result.error.message,
          details: result.error.details,
          recoverable: result.error.recoverable,
          next_action: result.error.nextAction,
        });
      }
      return mcpJson({
        quoteNotes: result.value.quoteNotes,
        legal: result.value.requirements.extra.daski.legal,
        agentAuthority: result.value.requirements.extra.daski.agentAuthority,
        purchaseNotice: result.value.requirements.extra.daski.purchaseNotice,
        paymentRequirements: result.value.requirements,
      });
    },
  );
}
