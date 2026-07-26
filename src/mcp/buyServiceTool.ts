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
    "REQUIRED CHOICE on the first paid call for a fresh wallet (no " +
      "agentId yet): the buyer identity minted by that call is permanent. " +
      "Pass your PRINCIPAL's exact stated business/entity name VERBATIM — " +
      "no abbreviations or variants — or pass useWalletDerivedName: true " +
      "instead. Omitting both pauses the call with " +
      "BUYER_NAME_ACKNOWLEDGEMENT_REQUIRED (nothing is consumed). An " +
      "already-registered wallet ignores this field harmlessly.",
  ),
  useWalletDerivedName: z.literal(true).optional().describe(
    "The explicit alternative to `name`: accept the permanent " +
      "wallet-derived default (buyer-<last6>). Pass exactly one of the " +
      "two on a fresh wallet's first paid call — never both.",
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
  phoneAcknowledgement: z
    .object({
      values: z.record(z.string(), z.string()).describe(
        "Exact phone field=value pairs as they appear in serviceArgs " +
          "(post-normalization, no separators).",
      ),
      principalConfirmed: z.literal(true),
    })
    .optional()
    .describe(
      "First-call phone acknowledgement: after echo-confirming the exact " +
        "normalized number(s) with your principal, bind them here to skip " +
        "the PHONE_ACKNOWLEDGEMENT_REQUIRED roundtrip. Values must match " +
        "the serviceArgs phone fields byte-for-byte.",
    ),
  phoneAcknowledgementToken: z.string().optional().describe(
    "Acknowledgement token returned when serviceArgs contain phone values " +
      "and no matching phoneAcknowledgement object was supplied.",
  ),
  buyerNameAcknowledgementToken: z.string().optional().describe(
    "Acknowledgement token returned when an atomic first purchase would " +
      "mint the wallet-derived default buyer name. Prefer passing `name`.",
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
  "FRESH WALLET? The first paid call for a wallet with no agentId mints a",
  "PERMANENT buyer identity: pass `name` (the principal's exact stated",
  "business/entity name, verbatim) or `useWalletDerivedName: true` on",
  "that very first call — exactly one of the two.",
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
