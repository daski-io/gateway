import {
  type McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
  "A fresh wallet's first paid call also mints its permanent buyer",
  "identity: pass `name` to choose it, or the wallet-derived default",
  "applies (the quote warns if the resolved name diverges from the",
  "request's companyName — correct it before signing if unintended).",
  "Phone values in serviceArgs land on public WHOIS exactly as sent; the",
  "quote result restates them in `warnings`.",
  "Settle by following the returned plan: sign the payment typed data,",
  "then call daski_settle_payment (the canonical settle path). A second",
  "call here with paymentPayload also settles (x402-middleware compat)",
  "but then serviceArgs MUST byte-match the quoted request — pick ONE",
  "settle path and never interleave the two.",
  "Entity-formation managementType and members/managers are TOP-LEVEL `serviceArgs` keys.",
  "There is NO `officials` or `officialsByClassification` wrapper. Party objects are",
  "STRICT — accepted keys: firstName, lastName, isCompany, companyName,",
  "jurisdictionCountry, dob, address. A party `phone` or `ownershipPercentage` is",
  "rejected at quote time (phone belongs to contactPerson only; ownership splits are",
  "operating-agreement data, not filing fields). Company parties (isCompany: true)",
  "MUST carry `jurisdictionCountry` (uppercase ISO 3166-1 alpha-2, e.g. \"US\")",
  "beside companyName.",
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
