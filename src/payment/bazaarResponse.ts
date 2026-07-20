import type { Request, Response } from "express";
import type { Config } from "../config.js";
import type { Hex } from "../types.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import type { ProviderQuoteCommitment } from "./providerQuote.js";
import type { SkillOffer } from "./skillOffer.js";

export function serviceArgsFrom(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body && typeof body === "object") {
    const args = (body as Record<string, unknown>).serviceArgs;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }
  }
  return {};
}

export function boundedTimeoutSeconds(
  config: Config,
  quote: ProviderQuoteCommitment,
): number | null {
  const remainingSeconds = Math.floor(
    (Date.parse(quote.expiresAt) - Date.now()) / 1000,
  );
  if (remainingSeconds < 15) return null;
  return Math.min(config.challengeTtlSeconds, remainingSeconds);
}

export function buildPaymentRequired(
  offer: SkillOffer,
  amount: bigint,
  config: Config,
  resourceUrl: string,
  maxTimeoutSeconds: number,
  purchaseLegal: PurchaseLegalContext,
  providerQuote?: ProviderQuoteCommitment,
  error?: string,
) {
  return {
    x402Version: 2,
    error: error ?? "PAYMENT-SIGNATURE header is required",
    resource: {
      url: resourceUrl,
      description: offer.description,
      mimeType: "application/json",
    },
    legal: purchaseLegal.legal,
    agentAuthority: purchaseLegal.agentAuthority,
    purchaseNotice: purchaseLegal.purchaseNotice,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${config.chainId}`,
        amount: amount.toString(),
        asset: config.usdcAddress,
        payTo: config.paymentRouterAddress,
        maxTimeoutSeconds,
        extra: {
          name: config.usdcName,
          version: config.usdcVersion,
          daski: {
            ...(providerQuote ? { providerQuote } : {}),
            ...purchaseLegal,
          },
        },
      },
    ],
    extensions: buildBazaarExtension(offer, config),
  };
}

export function receiptBody(
  config: Config,
  offer: Pick<SkillOffer, "skillId" | "providerA2AUrl">,
  fields: {
    paymentId: string;
    serviceRef: Hex;
    providerTokenId: string;
    buyerTokenId: string;
    amount: string;
    settlementTransaction: string | null;
    attributionTransaction: string | null;
    quoteId: string | null;
    quoteSignature: Hex | null;
    serviceArgs: Record<string, unknown>;
  },
) {
  const { quoteId, quoteSignature, serviceArgs, ...rest } = fields;
  return {
    x402Version: 2,
    receipt: {
      ...rest,
      skillId: offer.skillId,
      providerA2AUrl: offer.providerA2AUrl,
      ...(quoteId && quoteSignature
        ? { quote: { quoteId, quoteSignature } }
        : {}),
      serviceArgs,
      next: {
        description:
          "Payment settled and attributed on-chain. Dispatch the purchased " +
          "task to the provider (Daski MCP daski_submit_task, or direct A2A) " +
          "quoting paymentId — and with EXACTLY the serviceArgs echoed " +
          "above: the provider validates them against the signed quote. " +
          "Submit promptly; the quote commitment expires ~2 minutes after " +
          "issuance.",
        mcp: `${config.publicUrl}${config.mcpPath}`,
        skillDocs: `${config.publicUrl}/skill.md`,
      },
    },
  };
}

export function setSettlementHeaders(
  res: Response,
  settlement: Record<string, unknown>,
): void {
  const encoded = Buffer.from(JSON.stringify(settlement)).toString("base64");
  res.setHeader("PAYMENT-RESPONSE", encoded);
}

function buildBazaarExtension(offer: SkillOffer, config: Config) {
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "POST",
          bodyType: "json",
          body: { serviceArgs: {} },
        },
        output: {
          type: "json",
          example: {
            x402Version: 2,
            receipt: {
              paymentId: "42",
              serviceRef: "0x…",
              skillId: offer.skillId,
              providerA2AUrl: offer.providerA2AUrl,
              quote: { quoteId: "…", quoteSignature: "0x…" },
              next: {
                mcp: `${config.publicUrl}${config.mcpPath}`,
                skillDocs: `${config.publicUrl}/skill.md`,
              },
            },
          },
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: {
              serviceArgs: {
                type: "object",
                description:
                  "Skill-specific arguments from the provider Agent Card. " +
                  "The signed quote commits to these exact values.",
              },
            },
            additionalProperties: true,
          },
          output: {
            type: "object",
            properties: {
              x402Version: { type: "integer" },
              receipt: { type: "object" },
            },
          },
        },
      },
    },
  };
}
