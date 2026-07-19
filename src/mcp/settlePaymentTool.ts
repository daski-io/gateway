import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { settleChallenge } from "../payment/settlementCoordinator.js";
import type { Hex, PaymentPayload, PaymentRequirements } from "../types.js";
import type { McpDeps } from "./server.js";
import { mcpError, mcpJson, type McpToolResult } from "./util.js";

const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const SUPPORTED_NETWORKS = ["base", "base-sepolia"] as const;

export function registerSettlePaymentTool(server: McpServer, deps: McpDeps): void {
  server.registerTool(
    "daski_settle_payment",
    {
      description: [
        "**Advanced/manual.** Prefer `daski_buy_service` unless you called `daski_purchase` separately.",
        "",
        "Submit a signed x402 payment payload through the gateway facilitator.",
        "Your Operator is the legal party. Submitting payment authorization after the final purchase notice binds the Operator to the linked Daski and Provider Terms.",
        "Fresh wallets may include a signed registration so identity creation and settlement remain atomic.",
        "Returns the payment, transaction, service, provider, and buyer identifiers needed by daski_submit_task.",
      ].join("\n"),
      inputSchema: {
        paymentPayload: z
          .object({
            x402Version: z.literal(1),
            scheme: z.literal("exact"),
            network: z.enum(SUPPORTED_NETWORKS),
            payload: z.object({
              signature: z.string(),
              authorization: z.record(z.string(), z.unknown()),
            }),
          })
          .passthrough(),
        paymentRequirements: z.record(z.string(), z.unknown()),
        registration: z
          .object({
            agentURI: z.string(),
            deadline: z.string(),
            signature: z.string(),
          })
          .optional(),
      },
      annotations: {
        title: "Daski: settle payment",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<McpToolResult> => {
      const requirements = args.paymentRequirements as unknown as PaymentRequirements;
      const serviceRef = (requirements?.extra as { daski?: { serviceRef?: string } } | undefined)
        ?.daski?.serviceRef;
      if (typeof serviceRef !== "string" || !HEX_32.test(serviceRef)) {
        return mcpError({
          code: "BAD_INPUT",
          message: "paymentRequirements.extra.daski.serviceRef missing or malformed",
        });
      }
      const challenge = await deps.queries.getChallengeByRef(serviceRef.toLowerCase() as Hex);
      if (!challenge) {
        return mcpError({
          code: "CHALLENGE_NOT_FOUND",
          message: "no challenge found for the given serviceRef",
        });
      }

      const coordinated = await settleChallenge(
        {
          config: deps.config,
          reader: deps.reader,
          queries: deps.queries,
          fetchAgentCardFn: deps.buyerAgentCardFetch,
        },
        {
          paymentPayload: args.paymentPayload as unknown as PaymentPayload,
          challenge,
          registration: args.registration,
        },
      );
      if (coordinated.kind === "registration-required") {
        return mcpError({
          code: "registration_required",
          message:
            "this challenge was issued for an unregistered wallet. Pass a " +
            "signed RegisterAgent payload in registration.",
          recoverable: true,
          next_action: "Sign the RegisterAgent typed-data with the paying wallet and retry.",
        });
      }
      if (coordinated.kind === "invalid-registration") {
        return mcpError({
          code: "invalid_registration",
          message: coordinated.message,
        });
      }
      const result = coordinated.result;
      if (!result.ok) {
        return mcpError({
          code: result.errorReason,
          message: result.message,
          details: {
            transaction: result.response.transaction,
            payer: result.response.payer,
          },
          recoverable: false,
        });
      }
      const response = result.response;
      return mcpJson({
        success: true,
        transaction: response.transaction,
        network: response.network,
        payer: response.payer,
        paymentId: response.daski?.paymentId ?? null,
        serviceRef: response.daski?.serviceRef ?? null,
        providerTokenId: response.daski?.providerTokenId ?? null,
        buyerTokenId: response.daski?.buyerTokenId ?? null,
        amount: response.daski?.amount ?? null,
        providerA2AUrl: response.daski?.providerA2AUrl ?? null,
        skillId: challenge.skillId,
        registered: response.daski?.registered ?? false,
        quoteId: response.daski?.quoteId ?? null,
        quoteSignature: response.daski?.quoteSignature ?? null,
      });
    },
  );
}
