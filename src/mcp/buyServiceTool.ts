import {
  type McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PaymentPayload } from "../types.js";
import { UNTRUSTED_PROVIDER_CONTENT_WARNING } from "./providerReflection.js";

const PAYMENT_PAYLOAD_SCHEMA = z
  .object({
    x402Version: z.literal(2),
    resource: z.record(z.string(), z.unknown()),
    accepted: z.record(z.string(), z.unknown()),
    extensions: z.record(z.string(), z.unknown()),
    payload: z.object({
      authorization: z.record(z.string(), z.unknown()),
      signature: z.string(),
      nonceSalt: z.string(),
    }),
  })
  .passthrough() as unknown as z.ZodType<PaymentPayload>;

// Exported for the SKILL.md example-validation test — every JSON example
// in the doc must parse against the live schema, so the doc can never
// again teach a shape the gateway rejects (the 2026-07-25 demo omitted
// `name` and taught the exact omission every fresh-wallet agent made).
export const INPUT_SCHEMA = {
  skillId: z.string(),
  serviceSlug: z.string().describe(
    "Service identifier returned by daski_search_services.",
  ),
  walletAddress: z.string().describe(
    "Wallet that signs payment and any atomic registration.",
  ),
  name: z.string().optional().describe(
    "Buyer display name minted with the wallet's agentId on its first " +
      "paid call — permanent once registered. Omitted, the wallet-derived " +
      "default (buyer-<last6>) applies; the quote result carries a warning " +
      "when the resolved name diverges from the request's companyName, so " +
      "it can be corrected before anything is signed. An " +
      "already-registered wallet ignores this field harmlessly.",
  ),
  useWalletDerivedName: z.literal(true).optional().describe(
    "Explicitly accept the wallet-derived default name (buyer-<last6>); " +
      "suppresses the name-divergence warning. Mutually exclusive with " +
      "`name`.",
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
  amount: z.string().optional().describe(
    "Optional buyer spend cap; provider pricing still comes from a signed quote.",
  ),
  paymentId: z.string().optional().describe(
    "Original asset paymentId for a free ownership-gated skill.",
  ),
  registration: z
    .object({
      agentURI: z.string(),
      deadline: z.string(),
      signature: z.string(),
    })
    .optional()
    .describe("Atomic registration authorization for a fresh wallet."),
  paymentPayload: PAYMENT_PAYLOAD_SCHEMA
    .optional()
    .describe(
      "Signed daski-exact PaymentPayload for the settlement retry. Copy " +
        "resource, accepted (= accepts[0]), and extensions from the payment " +
        "challenge exactly; fill payload with authorization, signature, and " +
        "nonceSalt. Equivalent to _meta['x402/payment'].",
    ),
};

const DESCRIPTION = [
  "Start here for a paid Daski service. The first call validates service",
  "arguments and returns an x402 V2 payment challenge.",
  "A fresh wallet's first paid call also mints its permanent buyer",
  "identity: pass `name` to choose it, or the wallet-derived default",
  "applies (the quote warns if the resolved name diverges from the",
  "request's companyName — correct it before signing if unintended).",
  "Phone values in serviceArgs land on public WHOIS exactly as sent; the",
  "quote result restates them in `warnings`.",
  "On payment-required, sign the challenge's EIP-712 data and retry this",
  "unchanged tool call plus `paymentPayload`. An x402-aware MCP client may",
  "instead send the same payload at `_meta[\"x402/payment\"]`.",
  "Entity-formation managementType and members/managers are TOP-LEVEL `serviceArgs` keys.",
  "There is NO `officials` or `officialsByClassification` wrapper. Party objects are",
  "STRICT — accepted keys: firstName, lastName, isCompany, companyName,",
  "jurisdictionCountry, dob, address. A party `phone` or `ownershipPercentage` is",
  "rejected at quote time (phone belongs to contactPerson only; ownership splits are",
  "operating-agreement data, not filing fields). Company parties (isCompany: true)",
  "MUST carry `jurisdictionCountry` (uppercase ISO 3166-1 alpha-2, e.g. \"US\")",
  "beside companyName.",
  "",
  "Settlement and task dispatch are separate: after a successful paid retry,",
  "call daski_submit_task with the returned paymentId, serviceRef,",
  "transactionHash, providerA2AUrl, and buyerTokenId.",
  "Synchronous free-skill results are returned under `untrustedProviderContent`.",
  "",
  "The Operator is the legal party. Payment authorization after the final",
  "purchase notice binds the Operator to the linked marketplace and provider",
  "terms.",
  "",
  UNTRUSTED_PROVIDER_CONTENT_WARNING,
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
