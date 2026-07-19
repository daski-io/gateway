import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Express } from "express";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI, X402_VERSION } from "../config.js";
import { buildEnvelopeAuth, computeRequestHash } from "../auth/envelope.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import type {
  Hex,
  PaymentPayload,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";
import { extractAgentCardUrl } from "../discovery/format.js";
import { safeFetch } from "../util/urlSafety.js";
import { normalizeState } from "../util/a2aShape.js";
import { createQuotedChallenge } from "../payment/quotedChallenge.js";
import { settleChallenge } from "../payment/settlementCoordinator.js";
import { prepareRegistration } from "../identity/service.js";
import { walletControlsAgent } from "../identity/control.js";
import {
  checkPhoneConfirmation,
  checkPhoneFields,
  findUnknownServiceArgKeys,
  mcpError,
  mcpJson,
  parseBigIntArg,
  validateAndNormalizeServiceArgs,
  type McpToolResult,
} from "./util.js";
import { sanitizeBuyerName } from "../identity/name.js";
import {
  a2aPostJson,
  providerErrorFromFailure,
} from "./a2a.js";
import { registerArtifactTool } from "./artifact.js";
import { MCP_LEGAL_INSTRUCTIONS } from "../legal/purchase.js";
import {
  mountMcpHttpTransport,
  type McpWiring,
} from "./httpTransport.js";
import { GATEWAY_VERSION } from "../version.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import {
  sanitizeProviderArtifacts,
  sanitizeProviderValue,
} from "./providerReflection.js";
import { registerProviderResource } from "./providerResource.js";
import { instrumentToolCalls } from "./instrumentation.js";
import {
  findCatalogSkillAtA2AEndpoint,
  findProvidersOfferingSkill,
  type ProviderMatch,
} from "./providerCatalog.js";
import { registerDiscoveryTool } from "./discoveryTool.js";
import { registerPurchaseTool } from "./purchaseTool.js";
import { registerSettlePaymentTool } from "./settlePaymentTool.js";
import { registerConfirmDeliveryTool } from "./confirmDeliveryTool.js";
import { registerAgentTool } from "./registerAgentTool.js";
import { registerTaskStatusTool } from "./taskStatusTool.js";

// JSON response cap on provider A2A calls. Real responses are <50 KB; 1 MB
// is generous enough for unusual artifact payloads while still protecting
// against a malicious provider serving a multi-GB JSON body to OOM us.
const A2A_RESPONSE_MAX_BYTES = 1024 * 1024;
// ── Tool surface ──────────────────────────────────────────────────────────
//
// The MCP is wallet-agnostic. Signing belongs to the agent's wallet — the
// gateway never sees a private key. Tools that need a signature take the
// signed result as input and verify on-chain (settle, confirm). Tools that
// produce signing material return EIP-712 typed-data ready for a wallet's
// generic signTypedData operation.

export interface McpDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  pool: import("../db/pool.js").Pool;
  embedder?: import("../discovery/embeddings.js").Embedder | null;
  fetch?: typeof fetch;
  a2aTimeoutMs?: number;
  /**
   * Test seam for the buyer-side agentURI fetcher used by the atomic
   * register-and-settle path inside daski_settle_payment /
   * daski_buy_service. Defaults to the production safeFetch; the test
   * gateway plugs in a stub so atomic settles can populate
   * `buyer_identities` without a network call.
   */
  buyerAgentCardFetch?: import("../identity/fetch-agent-card.js").FetchAgentCardOptions["fetchFn"];
  maxSessions?: number;
  maxSessionsPerClient?: number;
  sessionIdleTtlMs?: number;
  sessionSweepIntervalMs?: number;
}

export type { McpWiring } from "./httpTransport.js";

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DEC_POSITIVE = /^[1-9][0-9]*$/;

// Buyer-supplied serviceArgs keys no advertised field consumes get a
// warning in the buy_service plan response — the provider will silently
// ignore them, and agents otherwise promise unsupported options to their
// principals (observed with create-mailbox display names).
function unknownServiceArgWarnings(
  skillMeta: { requiredFields?: unknown; optionalFields?: unknown },
  rawServiceArgs: Record<string, unknown> | undefined,
): string[] {
  const required = Array.isArray(skillMeta.requiredFields)
    ? (skillMeta.requiredFields as string[])
    : [];
  const optional = Array.isArray(skillMeta.optionalFields)
    ? (skillMeta.optionalFields as string[])
    : [];
  const unknown = findUnknownServiceArgKeys(rawServiceArgs, required, optional);
  if (unknown.length === 0) return [];
  return [
    `Unsupported serviceArgs ignored by this skill: ${unknown.join(", ")}. ` +
      `Supported fields — required: [${required.join(", ") || "none"}]; ` +
      `optional: [${optional.join(", ") || "none"}]. The skill will NOT act ` +
      `on the ignored fields; do not promise them to your principal.`,
  ];
}

// MCP enum sets — converted from free-text fields per the refactor brief so
// the model can't invent plausible-but-wrong values for cryptic protocol
// fields. Kept inline so any drift between docs and runtime is impossible.
const SUPPORTED_CHAIN_IDS = [8453, 84532] as const;
const SUPPORTED_NETWORKS = ["base", "base-sepolia"] as const;
const SUPPORTED_SCHEMES = ["exact"] as const;

// Server-level instructions — planted in the MCP `initialize` response and
// surfaced by Anthropic clients before any individual tool description. The
// canonical workflow lives here so the model has the map before it sees the
// individual tool surface.
const SERVER_INSTRUCTIONS = [
  "Daski lets your agent buy real-world business services — domain",
  "registration, LLC formation, hosting, email — by paying USDC on Base.",
  "The protocol is non-custodial; the gateway never holds funds.",
  "",
  MCP_LEGAL_INSTRUCTIONS,
  "",
  "Canonical workflow:",
  "  1. daski_search_services    — find a provider",
  "  2. daski_buy_service        — pay (auto-registers fresh wallets; pass `name` to pick your display name)",
  "  3. daski_submit_task        — dispatch the work (or for free skills, call directly)",
  "  4. daski_get_task_status    — poll until 'completed' or 'failed'",
  "  5. daski_fetch_artifact     — retrieve bytes behind a gated artifact URL",
  "  6. daski_confirm_delivery   — leave an on-chain attestation (optional)",
  "",
  "Other tools (daski_register_agent, daski_purchase, daski_settle_payment)",
  "are advanced/manual paths. Use them only when daski_buy_service doesn't fit.",
  "",
  "Sandbox runs on Base Sepolia testnet (chainId 84532). Faucet USDC:",
  "https://faucet.circle.com/. Mainnet (chainId 8453) launches after the next",
  "batch of service categories goes live.",
].join("\n");

// JSON-result wrappers — `mcpJson` and `mcpError` enforce the standardized
// MCP `CallToolResult` shape (content[0].type:"text", text:JSON.stringify(...))
// and the standardized error envelope `{ code, message, details?,
// recoverable?, next_action? }` from src/mcp/util.ts.
const json = (obj: unknown, meta?: Record<string, unknown>): McpToolResult =>
  mcpJson(obj, meta);

const errorJson = (
  error: { code: string; message: string; details?: Record<string, unknown>; recoverable?: boolean; next_action?: string },
  meta?: Record<string, unknown>,
): McpToolResult => mcpError(error, meta);

export async function createMcpServer(
  app: Express,
  deps: McpDeps,
): Promise<McpWiring> {
  // Default to safeFetch (validates host + pins resolved IP at connect).
  // Tests inject deps.fetch with a mock that ignores SSRF; the loose
  // signature means a `(url, init) => Promise<Response>` mock satisfies
  // safeFetch's `(url, init?, preValidated?)` signature without changes.
  const a2aFetch: (
    u: string,
    i?: RequestInit,
  ) => Promise<Response> = deps.fetch ?? safeFetch;
  const enforceUrlSafety = deps.fetch === undefined;
  const a2aTimeoutMs = deps.a2aTimeoutMs ?? 10_000;
  const identityDeps = {
    config: deps.config,
    reader: deps.reader,
    queries: deps.queries,
    fetchAgentCardFn: deps.buyerAgentCardFetch,
  };

  function registerTools(server: McpServer) {
    registerArtifactTool(server, {
      fetch: a2aFetch,
      timeoutMs: a2aTimeoutMs,
    });
    registerDiscoveryTool(server, deps);

    registerPurchaseTool(server, deps, {
      fetch: a2aFetch,
      timeoutMs: a2aTimeoutMs,
      maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
    });
    registerSettlePaymentTool(server, deps);

    registerConfirmDeliveryTool(server, deps);
    registerAgentTool(server, deps);

    // ── A2A: submit_task / check_task ────────────────────────────────

    const SUBMIT_TASK_INPUT_SCHEMA = {
      providerA2AUrl: z.string(),
      skillId: z.string(),
      paymentId: z
        .string()
        .describe(
          'Decimal string returned by `daski_buy_service`. Pass `"0"` ONLY ' +
            "for open free skills (check-availability, get-pricing). For " +
            "FREE but ownership-/capability-gated skills (get-domain-info, " +
            "list/set/delete-dns-record, get-mailbox-info, change-password, " +
            "delete-mailbox, transfer-domain-out, ...) pass the paymentId " +
            "of the ORIGINAL purchase that created the asset (e.g. the " +
            "register-domain or create-mailbox payment) — it is bound into " +
            "the envelope as a receipt reference. The gateway reads the " +
            "skill's advertised gating from the provider catalog and runs " +
            "the envelope handshake for gated skills even if you pass " +
            '`"0"`.',
        ),
      chainId: z
        .union(
          SUPPORTED_CHAIN_IDS.map((v) => z.literal(v)) as [
            z.ZodLiteral<8453>,
            z.ZodLiteral<84532>,
          ],
        )
        .describe(
          "Base chain ID. `8453` = mainnet, `84532` = Sepolia testnet.",
        ),
      buyerTokenId: z
        .string()
        .optional()
        .describe(
          "Optional. Auto-derived from `walletAddress` via the on-chain " +
            "AgentIndex when omitted. Pass explicitly only when the " +
            "caller wants a specific agentId for a wallet that holds " +
            "multiple Daski tokens (rare).",
        ),
      walletAddress: z
        .string()
        .optional()
        .describe(
          "Buyer wallet (0x-prefixed 20-byte hex). Used to auto-derive " +
            "`buyerTokenId` for the envelope-auth challenge on paid / " +
            "ownership-gated / capability-gated skills. Pass when you have " +
            "the wallet but not the agentId — typical right after " +
            "`daski_buy_service`'s second call. Either `buyerTokenId` or " +
            "`walletAddress` must be set for the first (no-envelopeAuth) call.",
        ),
      serviceRef: z
        .string()
        .optional()
        .describe(
          "32-byte hex string (`0x`-prefixed) returned by " +
            "`daski_buy_service`'s second call or `daski_settle_payment`. " +
            "Identifies the (provider, service) binding for this purchase. " +
            "Do not construct manually.",
        ),
      transactionHash: z
        .string()
        .optional()
        .describe(
          "0x-prefixed 32-byte hex Base transaction hash from the " +
            "settlement. Returned by `daski_buy_service` (second call) or " +
            "`daski_settle_payment`. Used by the provider to verify the " +
            "on-chain payment before doing work.",
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
      messageId: z
        .string()
        .optional()
        .describe(
          "REQUIRED whenever envelopeAuth is set — the envelope signature " +
            "binds to this exact value, and the provider rejects mismatches. " +
            "Echo the value returned in the first call's response. " +
            "Auto-generated only on the no-envelopeAuth first call.",
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
          "Omit on the first call for a paid / ownership-gated / " +
            "capability-gated skill to get back the typed-data the gateway " +
            "will accept on the retry. On the retry, pass " +
            "`{ signature, authorization }` alongside the matching `messageId`.",
        ),
      contextId: z
        .string()
        .optional()
        .describe(
          "A2A contextId — set when continuing a prior conversation " +
            "(e.g. follow-up after daski_buy_service). Auto-allocated " +
            "if omitted and returned in the result so the caller can " +
            "thread it through subsequent calls.",
        ),
      taskId: z
        .string()
        .optional()
        .describe(
          "Set ONLY to answer an existing task that is parked " +
            "`input-required` (long-running skills like `form-entity` ask " +
            "for corrected input this way). Routes this message as TASK " +
            "INPUT to that task instead of creating a new submission. Put " +
            "the corrected payload in `serviceArgs` — services with " +
            "redacted persistence need the FULL payload again, not a " +
            "delta. The first call returns CAPABILITY_REQUIRED with a " +
            "ready-to-sign `capabilityChallenge` (action=\"input\"): sign " +
            "it with the buyer's agent wallet and re-call with " +
            "`capability: { signature, authorization }`. Do NOT combine " +
            "with serviceRef/transactionHash/envelopeAuth — and NEVER set " +
            "taskId on a capability-gated WRITE resubmit (input-required " +
            "WITH a capability_challenge artifact, e.g. set-dns-record): " +
            "that flow keeps the same contextId and rejects taskId as " +
            "BAD_INPUT.",
        ),
    };

    type SubmitTaskArgs = {
      providerA2AUrl: string;
      skillId: string;
      paymentId: string;
      chainId: 8453 | 84532;
      buyerTokenId?: string;
      walletAddress?: string;
      serviceRef?: string;
      transactionHash?: string;
      prompt?: string;
      serviceArgs?: Record<string, unknown>;
      capability?: {
        signature: string;
        authorization: Record<string, unknown>;
      };
      messageId?: string;
      envelopeAuth?: {
        signature: string;
        authorization: {
          buyerTokenId: string;
          skillId: string;
          paymentId: string;
          chainId: number;
          messageId: string;
          requestHash: string;
          issuedAt: string;
        };
      };
      contextId?: string;
      taskId?: string;
    };

    const submitTaskHandler = async (
      args: SubmitTaskArgs,
    ): Promise<McpToolResult> => {
        // Task-input mode: answering an `input-required` task addresses an
        // EXISTING task. Authentication is the action:"input"
        // TaskAccessAuthorization (the provider issues a ready-to-sign
        // challenge on the first attempt), NOT an envelope — and a
        // serviceRef in the metadata would route the provider away from
        // its task-input handler. Refuse the mix instead of guessing.
        if (
          args.taskId &&
          (args.serviceRef || args.transactionHash || args.envelopeAuth)
        ) {
          // Two distinct caller mistakes land here. With an envelopeAuth
          // the caller is almost certainly mid-capability-gated-write
          // (contextId flow) and wrongly added taskId; without one they
          // are doing task input and wrongly added paid-skill refs. Give
          // each the fix for ITS flow — the old one-size message told
          // capability-flow callers to keep taskId, the opposite of the fix.
          const inCapabilityFlow = Boolean(args.envelopeAuth);
          return errorJson({
            code: "BAD_INPUT",
            message: inCapabilityFlow
              ? "You sent envelopeAuth, which marks this as a " +
                "capability-gated write resubmit (input-required WITH a " +
                "capability_challenge artifact) — that flow addresses the " +
                "task via contextId. REMOVE taskId and resubmit with the " +
                "same contextId, the fresh envelopeAuth + its messageId, " +
                "capability, and serviceArgs. Only send taskId — with NO " +
                "envelopeAuth/serviceRef/transactionHash — when answering " +
                "a long-running task that went input-required WITHOUT a " +
                "capability_challenge artifact."
              : "taskId marks this call as task input to an existing " +
                "task — do not combine it with serviceRef/transactionHash. " +
                "Pass providerA2AUrl, skillId, paymentId, chainId, taskId " +
                "and serviceArgs (the corrected payload); after the " +
                "CAPABILITY_REQUIRED challenge, add capability.",
            recoverable: true,
            next_action: inCapabilityFlow
              ? "Drop taskId; re-call with contextId + envelopeAuth + " +
                "messageId + capability + serviceArgs."
              : "Re-call with taskId + serviceArgs only (+ capability " +
                "after signing the returned challenge).",
          });
        }

        const catalogEndpoint = findCatalogSkillAtA2AEndpoint(
          deps.cache,
          args.providerA2AUrl,
          args.skillId,
        );
        if (!catalogEndpoint) {
          return errorJson({
            code: "SKILL_ENDPOINT_NOT_CATALOGED",
            message:
              "The providerA2AUrl and skillId pair is not advertised by a " +
              "currently whitelisted provider. No outbound request was made.",
          });
        }
        const cachedSkillMeta = catalogEndpoint.skillMeta;

        // Stateless drift check: when the caller supplies a signed
        // envelope, the serviceArgs they send MUST canonically hash to the
        // requestHash inside it. Catching the mismatch here turns the
        // provider's post-roundtrip -32110 into an instant local error
        // (classic drift: appending a defaulted `ttl` to a capability
        // resubmit after signing — both domain scenarios tripped it).
        if (args.envelopeAuth?.authorization?.requestHash) {
          let sentHash: Hex;
          try {
            sentHash = computeRequestHash(args.serviceArgs ?? {});
          } catch (error) {
            return errorJson({
              code: "BAD_INPUT",
              message: `serviceArgs cannot be canonically hashed: ${(error as Error).message}`,
            });
          }
          if (
            sentHash.toLowerCase() !==
            args.envelopeAuth.authorization.requestHash.toLowerCase()
          ) {
            return errorJson({
              code: "REQUEST_HASH_MISMATCH",
              message:
                "serviceArgs do not hash to envelopeAuth.authorization" +
                ".requestHash — the body changed AFTER the envelope was " +
                "signed (classic: appending a field the provider would " +
                "have defaulted, like `ttl`, on a capability resubmit; " +
                "authorization fields such as recordTtl are signature " +
                "bindings, never serviceArgs fields). Nothing was sent to " +
                "the provider. Resend the EXACT serviceArgs object the " +
                "envelope was built from — same fields, same values, no " +
                "additions — keeping the SAME signatures; or start a " +
                "fresh envelope challenge for the genuinely new body.",
              recoverable: true,
              next_action:
                "Retry with the original serviceArgs unchanged (same " +
                "envelopeAuth + capability), or request a new envelope " +
                "challenge if you intend different args.",
            });
          }
        }

        // Envelope-auth is needed for every paid skill and every
        // ownership-/capability-gated free skill. The skill's advertised
        // gating in the discovery cache is the source of truth: agents
        // routinely pass `paymentId: "0"` for gated FREE skills
        // (change-password, get-domain-info, ...) because "free" reads as
        // "no payment id", which previously skipped the handshake and
        // bounced them off the provider's ENVELOPE_AUTH_REQUIRED. A paid
        // execution (serviceRef + transactionHash) always authenticates.
        // Task input (taskId set) never does — the capability is the
        // credential.
        const metaDeclaresGating =
          "paymentRequired" in cachedSkillMeta ||
          "requiresAssetOwnership" in cachedSkillMeta ||
          "requiresCapability" in cachedSkillMeta;
        let paidChallenge: StoredChallenge | null = null;

        // A paid envelope binds paymentId and serviceArgs, while the paid-path
        // routing fields live alongside it. Recover omitted routing fields on
        // a signed retry from the gateway's settled challenge so the provider
        // never receives a request that can only fail as "not paid path".
        if (
          !args.taskId &&
          args.envelopeAuth &&
          cachedSkillMeta?.paymentRequired === true &&
          (!args.serviceRef || !args.transactionHash)
        ) {
          if (!DEC_POSITIVE.test(args.paymentId)) {
            return errorJson({
              code: "PAYMENT_ID_INVALID",
              message:
                "A paid signed retry needs the positive decimal paymentId " +
                "returned by settlement. No task was dispatched.",
            });
          }
          try {
            paidChallenge = await deps.queries.getChallengeByPaymentId(
              BigInt(args.paymentId),
            );
          } catch {
            return errorJson({
              code: "QUOTE_LOOKUP_FAILED",
              message:
                "The gateway could not restore serviceRef and transactionHash " +
                "from this settled payment. No task was dispatched; re-add " +
                "both fields from daski_settle_payment and resend the same " +
                "signed retry — do not re-sign.",
              recoverable: true,
              next_action:
                "Re-call with the same envelopeAuth/messageId plus the original " +
                "serviceRef and transactionHash.",
            });
          }
          if (
            !paidChallenge ||
            paidChallenge.status !== "paid" ||
            paidChallenge.paymentId === null ||
            paidChallenge.transactionHash === null
          ) {
            return errorJson({
              code: "PAID_PATH_CREDENTIALS_NOT_FOUND",
              message:
                "No settled gateway payment matches this paymentId, so " +
                "serviceRef and transactionHash could not be restored. No " +
                "task was dispatched; re-add both settlement fields and " +
                "resend the same signed retry — do not re-sign.",
              recoverable: true,
              next_action:
                "Re-call with the same envelopeAuth/messageId plus the original " +
                "serviceRef and transactionHash.",
            });
          }
          const restoredBindingMismatch =
            paidChallenge.skillId !== args.skillId ||
            paidChallenge.providerA2AUrl !== args.providerA2AUrl ||
            paidChallenge.buyerTokenId.toString() !==
              args.envelopeAuth.authorization.buyerTokenId ||
            (args.serviceRef !== undefined &&
              paidChallenge.serviceRef.toLowerCase() !==
                args.serviceRef.toLowerCase()) ||
            (args.transactionHash !== undefined &&
              paidChallenge.transactionHash.toLowerCase() !==
                args.transactionHash.toLowerCase());
          if (restoredBindingMismatch) {
            return errorJson({
              code: "PAYMENT_BINDING_MISMATCH",
              message:
                "The signed retry conflicts with the settled payment's " +
                "serviceRef, transactionHash, skill, provider, or buyer. No " +
                "task was dispatched.",
            });
          }
          args.serviceRef = paidChallenge.serviceRef;
          args.transactionHash = paidChallenge.transactionHash;
        }

        const requiresEnvelopeAuth = args.taskId
          ? false
          : args.serviceRef !== undefined && args.transactionHash !== undefined
            ? true
            : cachedSkillMeta !== null && metaDeclaresGating
              ? cachedSkillMeta.paymentRequired === true ||
                cachedSkillMeta.requiresAssetOwnership === true ||
                cachedSkillMeta.requiresCapability === true
              : args.paymentId !== "0" && args.paymentId !== "";

        if (args.serviceRef && !args.taskId) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(args.serviceRef)) {
            return errorJson({
              code: "BAD_INPUT",
              message: "serviceRef must be a 0x-prefixed 32-byte hex value.",
            });
          }
          if (!paidChallenge) {
            try {
              paidChallenge = await deps.queries.getChallengeByRef(
                args.serviceRef.toLowerCase() as Hex,
              );
            } catch {
              return errorJson({
                code: "QUOTE_LOOKUP_FAILED",
                message:
                  "The gateway could not load the settled quote credentials. " +
                  "No task was dispatched; retry this call.",
                recoverable: true,
                next_action: "Retry daski_submit_task with the same arguments.",
              });
            }
          }
          if (!paidChallenge) {
            return errorJson({
              code: "PAYMENT_CHALLENGE_NOT_FOUND",
              message:
                "No gateway payment challenge matches this serviceRef. " +
                "No task was dispatched.",
            });
          }
          if (
            paidChallenge.status !== "paid" ||
            paidChallenge.paymentId === null ||
            paidChallenge.transactionHash === null
          ) {
            return errorJson({
              code: "PAYMENT_NOT_SETTLED",
              message:
                "The payment challenge has not completed settlement. " +
                "Settle it before dispatching the task.",
              recoverable: true,
            });
          }
          const bindingMismatch =
            paidChallenge.skillId !== args.skillId ||
            paidChallenge.paymentId.toString() !== args.paymentId ||
            paidChallenge.providerA2AUrl !== args.providerA2AUrl ||
            !args.transactionHash ||
            paidChallenge.transactionHash.toLowerCase() !==
              args.transactionHash.toLowerCase();
          if (bindingMismatch) {
            return errorJson({
              code: "PAYMENT_BINDING_MISMATCH",
              message:
                "serviceRef, paymentId, transactionHash, skillId, and " +
                "providerA2AUrl must all describe the same settled challenge. " +
                "No task was dispatched.",
            });
          }
          if (
            !paidChallenge.quoteId ||
            !paidChallenge.quoteSignature ||
            !paidChallenge.quoteRequestHash
          ) {
            return errorJson({
              code: "QUOTE_CREDENTIALS_MISSING",
              message:
                "The settled challenge has no complete provider quote " +
                "commitment. No task was dispatched.",
            });
          }
          let requestHash: Hex;
          try {
            requestHash = computeRequestHash(args.serviceArgs ?? {});
          } catch (error) {
            return errorJson({
              code: "BAD_INPUT",
              message: `serviceArgs cannot be canonically hashed: ${(error as Error).message}`,
            });
          }
          if (
            requestHash.toLowerCase() !==
            paidChallenge.quoteRequestHash.toLowerCase()
          ) {
            return errorJson({
              code: "QUOTE_REQUEST_MISMATCH",
              message:
                "serviceArgs differ from the request committed by the " +
                "provider quote. No task was dispatched.",
            });
          }
        }

        // First-call branch — return the typed-data the wallet must sign,
        // plus the matching messageId to thread back through.
        if (requiresEnvelopeAuth && !args.envelopeAuth) {
          // Auto-derive buyerTokenId when the caller passes a wallet but
          // not its agent id. The on-chain AgentIndex (verified against
          // the canonical registry) is the source of truth; we already
          // use the same call in daski_buy_service. Saves the agent from
          // parsing tx receipts when they just settled a payment for the
          // same wallet.
          let buyerTokenId = args.buyerTokenId;
          if (!buyerTokenId && args.walletAddress) {
            if (!HEX_ADDR.test(args.walletAddress)) {
              return errorJson({
                code: "BAD_INPUT",
                message:
                  "walletAddress must be a 0x-prefixed 20-byte hex address.",
              });
            }
            try {
              const agentId = await deps.reader.agentOfWallet(
                args.walletAddress.toLowerCase() as Hex,
              );
              if (agentId === 0n) {
                return errorJson({
                  code: "WALLET_NOT_REGISTERED",
                  message:
                    `Wallet ${args.walletAddress} has no ERC-8004 agentId on chain ${args.chainId}. ` +
                    "Register it via daski_register_agent (or let daski_buy_service " +
                    "register it atomically on first purchase) before calling submit_task.",
                  recoverable: true,
                  next_action:
                    "Call daski_register_agent with this walletAddress, or run a " +
                    "daski_buy_service flow first.",
                });
              }
              buyerTokenId = agentId.toString();
            } catch (err) {
              return errorJson({
                code: "CHAIN_READ_FAILED",
                message:
                  publicErrorMessage(
                    "mcp.submitTask.agentOfWallet",
                    err,
                    "buyer identity lookup failed",
                  ),
                recoverable: true,
                next_action:
                  "Retry, or pass buyerTokenId directly if you already know it.",
              });
            }
          }
          if (!buyerTokenId) {
            // Point callers at buyer identity sources rather than the
            // provider catalog.
            return errorJson({
              code: "BAD_INPUT",
              message:
                "buyerTokenId not provided. If you just settled a payment, " +
                "it's in the daski_buy_service second-call response as " +
                "`buyerTokenId`. For a wallet you've used before, pass " +
                "`walletAddress` and the gateway auto-derives via the " +
                "on-chain AgentIndex.",
              recoverable: true,
              next_action:
                "Re-call this tool with either `buyerTokenId` or `walletAddress` set.",
            });
          }
          const envelope = buildEnvelopeAuth({
            skillId: args.skillId,
            paymentId: args.paymentId,
            chainId: args.chainId,
            buyerTokenId,
            identityRegistryAddress: deps.config.identityRegistryAddress,
            serviceArgs: args.serviceArgs ?? {},
            messageId: args.messageId,
          });
          return json({
            messageId: envelope.messageId,
            requestHash: envelope.requestHash,
            issuedAt: envelope.issuedAt,
            authorization: envelope.authorization,
            eip712TypedData: envelope.eip712TypedData,
            hint:
              "Sign eip712TypedData with the buyer agent wallet, then " +
              "make the second call as this first call's EXACT arguments " +
              "plus envelopeAuth: { signature, authorization } and the SAME " +
              "messageId — remove nothing, including serviceRef and " +
              "transactionHash for a paid skill.",
          });
        }

        // §2.1 — A2A v0.3.0 envelope. parts use `kind:"text"|"data"` (not
        // `type`), the message has a required `messageId` and optional
        // `contextId` for multi-turn conversations.
        const parts: Array<Record<string, unknown>> = [];
        if (args.prompt) {
          parts.push({ kind: "text", text: args.prompt });
        } else {
          parts.push({ kind: "text", text: `Execute skill ${args.skillId}` });
        }
        if (args.serviceArgs && Object.keys(args.serviceArgs).length > 0) {
          parts.push({ kind: "data", data: args.serviceArgs });
        }
        const meta: Record<string, unknown> = {
          skillId: args.skillId,
          paymentId: args.paymentId,
          chainId: args.chainId,
        };
        if (args.serviceRef) meta.serviceRef = args.serviceRef;
        if (args.transactionHash) meta.transactionHash = args.transactionHash;
        // Task-input routing: providers dispatch on metadata.taskId (with
        // no serviceRef) to their task-input handler.
        if (args.taskId) meta.taskId = args.taskId;
        if (args.capability) meta.capability = args.capability;
        if (args.envelopeAuth) meta.envelopeAuth = args.envelopeAuth;

        if (paidChallenge) {
          meta.quoteId = paidChallenge.quoteId;
          meta.quoteSignature = paidChallenge.quoteSignature;
        }

        // When the buyer signs envelopeAuth they commit to a specific
        // messageId. We must thread that same value here — auto-generating
        // would invalidate the signature.
        if (args.envelopeAuth && !args.messageId) {
          return errorJson({
            code: "MESSAGE_ID_REQUIRED",
            message:
              "messageId must be supplied alongside envelopeAuth so the " +
              "A2A envelope matches what the buyer signed. Pass the same " +
              "messageId returned by the first (no-envelopeAuth) call.",
          });
        }
        if (
          args.envelopeAuth &&
          args.messageId &&
          args.envelopeAuth.authorization.messageId !== args.messageId
        ) {
          return errorJson({
            code: "MESSAGE_ID_MISMATCH",
            message:
              `envelopeAuth.authorization.messageId=${args.envelopeAuth.authorization.messageId} ` +
              `but submit_task messageId=${args.messageId}. They must match.`,
          });
        }
        const messageId = args.messageId ?? randomUUID();
        const contextId = args.contextId ?? randomUUID();

        // A2A v1.0 §5.3 mandates PascalCase method names.
        const body = {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "SendMessage",
          params: {
            message: {
              role: "ROLE_USER",
              parts,
              messageId,
              contextId,
              metadata: { [DASKI_A2A_EXTENSION_URI]: meta },
            },
          },
        };

        type SubmitRpc = {
          error?: { code?: number; message?: string; data?: unknown };
          result?: {
            id?: string;
            contextId?: string;
            status?: {
              state?: string;
              message?: { role?: string; parts?: unknown[] } | unknown;
            };
            artifacts?: unknown[];
          };
        };
        const post = await a2aPostJson<SubmitRpc>(args.providerA2AUrl, body, {
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxBytes: A2A_RESPONSE_MAX_BYTES,
          failOnNonOk: true,
        });
        if (!post.ok) {
          // The request MAY have reached the provider before the
          // timeout/failure — and envelopes are single-use, so "just retry"
          // guidance causes ENVELOPE_REPLAY (observed in the agentic e2e:
          // an agent followed the old wording verbatim and burned a
          // diagnostic roundtrip).
          return providerErrorFromFailure(post, args.providerA2AUrl, {
            contextId,
            nextAction:
              "The request MAY have been processed before the failure and any " +
              "signed envelope is now consumed — do NOT re-send the same " +
              "envelope/messageId (it will be rejected as ENVELOPE_REPLAY). " +
              "First verify actual state with a read-only skill (get-domain-info, " +
              "list-dns-records, get-mailbox-info, …). Only if the action did NOT " +
              "take effect, request a FRESH envelope (new first call, new messageId) " +
              "and retry with the same contextId.",
          });
        }
        const rpc = post.body;
        if (rpc.error) {
          // Providers embed recovery material in JSON-RPC error.data — the
          // ENVELOPE_AUTH_REQUIRED error carries a ready-to-sign
          // `envelopeAuthChallenge`, for example. Pass it through verbatim
          // (as details.data) instead of stranding the agent with a bare
          // message that references a payload it can't see.
          return errorJson({
            code: "PROVIDER_ERROR",
            message: sanitizeProviderValue(
              rpc.error.message ?? "JSON-RPC error",
            ),
            details: {
              contextId,
              ...(rpc.error.code !== undefined
                ? { rpcCode: rpc.error.code }
                : {}),
              ...(rpc.error.data !== undefined
                ? {
                    data: sanitizeProviderValue(rpc.error.data),
                  }
                : {}),
            },
          });
        }
        if (!rpc.result?.id) {
          return errorJson({
            code: "PROVIDER_ERROR",
            message: "Provider response missing result.id",
            details: { contextId },
          });
        }
        // Synchronous-completing skills (open-free like check-availability)
        // return the full answer inline — artifacts on the JSON-RPC result,
        // a final status.message. Pass them through so the agent doesn't
        // have to call daski_get_task_status on a non-persistent qa-* taskId
        // (which would 404 because those tasks aren't stored). Async
        // skills (paid, ownership-gated) include neither — agent polls.
        const result = rpc.result;
        const flattened: Record<string, unknown> = {
          taskId: result.id,
          // The provider's response can include its own contextId — prefer
          // that when present so multi-turn replies stay aligned with the
          // server's view; fall back to ours.
          contextId: result.contextId ?? contextId,
          // MCP consumers use compact kebab-case states; normalize the
          // provider's ProtoJSON enum at the boundary.
          state: normalizeState(result.status?.state) ?? "submitted",
          providerA2AUrl: args.providerA2AUrl,
        };
        if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
          flattened.artifacts = sanitizeProviderArtifacts(result.artifacts);
        }
        if (result.status?.message) {
          flattened.statusMessage = sanitizeProviderValue(
            result.status.message,
          );
        }
        // A capability challenge (`input-required` + capability_challenge
        // artifact) always needs a SECOND provider call to execute, and
        // envelopes are single-use — resubmitting with the envelope that
        // produced this challenge fails with ENVELOPE_REPLAY. Pre-mint the
        // fresh envelope for the execute call here so the agent signs the
        // capability and the next envelope in one pass.
        const capabilityChallengeReturned =
          flattened.state === "input-required" &&
          Array.isArray(result.artifacts) &&
          result.artifacts.some(
            (a) =>
              a !== null &&
              typeof a === "object" &&
              (a as Record<string, unknown>).name === "capability_challenge",
          );
        if (capabilityChallengeReturned && args.envelopeAuth) {
          const nextEnvelope = buildEnvelopeAuth({
            skillId: args.skillId,
            paymentId: args.paymentId,
            chainId: args.chainId,
            buyerTokenId: args.envelopeAuth.authorization.buyerTokenId,
            identityRegistryAddress: deps.config.identityRegistryAddress,
            serviceArgs: args.serviceArgs ?? {},
          });
          flattened.nextEnvelopeAuthChallenge = {
            messageId: nextEnvelope.messageId,
            requestHash: nextEnvelope.requestHash,
            issuedAt: nextEnvelope.issuedAt,
            authorization: nextEnvelope.authorization,
            eip712TypedData: nextEnvelope.eip712TypedData,
            hint:
              "Envelopes are single-use: the execute call needs THIS fresh " +
              "envelope, not the one you just used. Sign the capability " +
              "challenge AND this eip712TypedData, then call " +
              "daski_submit_task again with capability: { signature, " +
              "authorization }, envelopeAuth from THIS challenge, " +
              "messageId set to THIS challenge's messageId, the same " +
              "first-call arguments (including serviceRef and " +
              "transactionHash for paid skills), and the returned contextId.",
          };
        }
        return json(flattened);
    };

    server.registerTool(
      "daski_submit_task",
      {
        description: [
          "Dispatch a task to a Daski provider over A2A. Use for free skills (price checks, availability, capability prep) and as the second step after `daski_buy_service` for paid skills.",
          "",
          "When to use:",
          "- OPEN free skills like `check-availability`, `get-pricing` (pass `paymentId: \"0\"`, omit `envelopeAuth` — no handshake, completes synchronously).",
          "  For entity-formation `get-pricing`, work in two steps: `country` + `state` (2-letter code) lists that state's (entityType, product) combinations with prices; repeat with `entityType` + `product` added for the full `requiredFields` contract. `entityType` must be the full label from the combinations list (e.g. 'Limited Liability Company', never 'LLC'). Keep the filters narrow — country-wide calls return very large responses.",
          "- FREE ownership-/capability-gated skills (`get-domain-info`, `list/set/delete-dns-record`, `get-mailbox-info`, `change-password`, `delete-mailbox`, `transfer-domain-out`, ...) — same two-call envelope handshake as paid skills; pass the ORIGINAL asset purchase's `paymentId` plus `buyerTokenId` or `walletAddress`. (`daski_buy_service` also emits a ready-made step-by-step plan for these.)",
          "- After `daski_buy_service` settled a payment — dispatch the actual task using the returned `serviceRef` and `transactionHash`.",
          "- Continuing a multi-turn A2A conversation — pass the `contextId` from the previous turn.",
          "- An existing long-running task went `input-required` (it asked for corrected input, e.g. an entity filing rejecting a field) — pass `taskId` + the corrected `serviceArgs` (see Inputs).",
          "",
          "When NOT to use:",
          "- You are starting a paid purchase — use `daski_buy_service` first; it returns the `serviceRef` and `transactionHash` you'll need here.",
          "- You are polling an existing task — use `daski_get_task_status`.",
          "",
          "Inputs:",
          "- Open free skill: `skillId`, `providerA2AUrl`, `chainId`, `paymentId: \"0\"`, `serviceArgs`.",
          "- Gated skill (paid or free), first call (no signature): `skillId`, `providerA2AUrl`, `chainId`, `paymentId`, `buyerTokenId` (or `walletAddress`), `serviceArgs`; paid skills additionally `serviceRef` + `transactionHash`. Returns the envelope-auth typed-data to sign.",
          "- Gated skill, signed retry: second call = the first call's EXACT arguments + `envelopeAuth: { signature, authorization }` + the matching `messageId`, NOTHING REMOVED. Paid retries must keep `serviceRef` + `transactionHash`. The gateway restores accidentally omitted values when it can verify the settled payment; if it cannot, re-add the original two fields and resend the SAME signed retry — do not re-sign.",
          "- Task input (answering `input-required` on an existing task): `skillId`, `providerA2AUrl`, `chainId`, `paymentId`, `taskId`, `serviceArgs` — the FULL corrected payload, not a delta (providers persist requests redacted, so a delta can't be merged; the task's status message says exactly which fields were rejected). NO serviceRef/transactionHash/envelopeAuth. The first call returns a PROVIDER_ERROR with `details.data.capabilityChallenge` (ready-to-sign, action=\"input\"): sign its `eip712TypedData` with the buyer's agent wallet, then re-call the same inputs plus `capability: { signature, authorization }` (echo `capabilityChallenge.authorization` verbatim).",
          "",
          "Returns:",
          "- First call on a gated skill: `{ eip712TypedData, authorization, messageId, hint }`. Sign `eip712TypedData` with the buyer's agent wallet, then call again with `envelopeAuth: { signature, authorization }` and the SAME `messageId`.",
          "- Otherwise: `{ taskId, contextId, state, artifacts, statusMessage }`. `state` is one of `submitted | working | input-required | completed | failed`. `completed` and `failed` are terminal.",
          "- Non-terminal (`submitted`/`working`) responses may bundle a `task_access_challenge` artifact: a ready-to-sign action=\"get\" TaskAccessAuthorization for THIS task. Sign its `eip712TypedData` with the buyer wallet right away and pass `capability: { signature, authorization }` on your very first `daski_get_task_status` poll — that skips the otherwise-guaranteed first-poll -32107 handshake. Reuse the same signed capability on every later poll until `authorization.expiry`.",
          "- Capability-gated skills (`set-dns-record`, `delete-dns-record`, `transfer-domain-out`, `change-password`, `delete-mailbox`) return `state: 'input-required'` with a `capability_challenge` artifact plus `nextEnvelopeAuthChallenge` (a pre-minted FRESH envelope — envelopes are single-use). Sign BOTH typed-datas, then resubmit with `capability`, the fresh `envelopeAuth` + its `messageId`, and the same `contextId` — NOT `taskId` (mixing `taskId` into this resubmit is rejected as BAD_INPUT). Budget 3 signatures per gated write (initial envelope, capability, fresh envelope) — changing N records costs 3×N.",
          "",
          "Next step:",
          "- `state === 'completed'`: read `artifacts`, then optionally `daski_confirm_delivery`.",
          "- `state === 'working' | 'submitted'`: poll with `daski_get_task_status`. If the response bundled a `task_access_challenge` artifact, sign it first and include `capability` on that first poll.",
          "- `state === 'input-required'` WITH a `capability_challenge` artifact (capability-gated write like `set-dns-record`): resubmit with the same `contextId`, the fresh `envelopeAuth` + its `messageId`, and `capability`. Do NOT set `taskId` and do NOT include `serviceRef`/`transactionHash` — passing `taskId` here is rejected as BAD_INPUT. Only the long-running correction branch (next bullet) uses `taskId`. The resubmitted `serviceArgs` must match the body you SIGNED exactly — do not add, remove, normalize, or default ANY field after signing (classic mistake: appending `ttl`); any drift fails with a -32110 requestHash mismatch.",
          "- `state === 'input-required'` WITHOUT a `capability_challenge` artifact (a long-running task asking for corrected input): re-call with `taskId` set to the returned taskId and the FULL corrected `serviceArgs`; expect one CAPABILITY_REQUIRED round-trip (see Inputs, task input).",
          "- `state === 'failed'`: read `statusMessage`, optionally `daski_confirm_delivery` with `confirmation: 'NotConfirmed'`.",
          "- On PROVIDER_TIMEOUT or a provider-side error AFTER you submitted a signed envelope: the envelope may already be consumed. Never re-send the same messageId/envelope (ENVELOPE_REPLAY). Confirm actual state with a read-only skill first; if you must retry, start from a fresh first call (new messageId).",
        ].join("\n"),
        inputSchema: SUBMIT_TASK_INPUT_SCHEMA,
        annotations: {
          title: "Run a Daski task",
          // Static annotations can't reflect the paid/free split: free
          // skills are read-only, paid ones submit a chargeable task. We
          // pick the conservative defaults (destructive=true) so clients
          // that auto-confirm on `destructiveHint:false` still prompt
          // before money moves. The "When to use" block above explains
          // the difference for free skills.
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      submitTaskHandler,
    );

    registerTaskStatusTool(server, deps, {
      fetch: a2aFetch,
      timeoutMs: a2aTimeoutMs,
      enforceUrlSafety,
      maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
    });

    // ── daski_buy_service path helpers ────────────────────────────────
    //
    // The orchestrator splits cleanly into three named paths:
    //   1. x402 retry — when paymentPayload arrives, verify and settle,
    //      then return the context required by daski_submit_task.
    //   2. Free skill — open-free (synchronous direct dispatch) or
    //      ownership-gated (multi-step plan).
    //   3. Paid skill — live /quote against the provider, then
    //      paymentRequirements + EIP-712 typed-data.
    // Each helper takes a shared `BuyServiceCtx` so the dispatcher stays
    // narrow (validate → resolve → dispatch). Function declarations
    // hoist within `registerTools`, so they appear after the registered
    // tool body that calls them.

    interface BuyServiceArgs {
      skillId: string;
      serviceSlug: string;
      walletAddress: string;
      name?: string;
      buyerTokenId?: string;
      providerTokenId?: string;
      serviceArgs?: Record<string, unknown>;
      amount?: string;
      paymentId?: string;
      paymentPayload?: Record<string, unknown>;
      paymentRequirements?: Record<string, unknown>;
      registration?: { agentURI: string; deadline: string; signature: string };
    }

    interface BuyServiceCtx {
      args: BuyServiceArgs;
      provider: ProviderMatch;
      providerA2AUrl: string;
      serviceArgs: Record<string, unknown>;
      buyerAgentId: bigint;
      /** Sanitized display name for the atomic registration, when the
       *  caller supplied one. Undefined → wallet-derived default. */
      buyerName?: string;
    }

    // Synchronous free skills are explicitly declared by the provider.
    function resolveSynchronousDispatch(
      skillMeta: Record<string, unknown>,
    ): { endpoint: string; kind: string } | null {
      const direct = skillMeta["directEndpoint"];
      if (typeof direct === "string" && direct.startsWith("/")) {
        const kind =
          typeof skillMeta["directResultKind"] === "string"
            ? (skillMeta["directResultKind"] as string)
            : "direct";
        return { endpoint: direct, kind };
      }
      return null;
    }

    function resolveBuyServiceProvider(
      args: BuyServiceArgs,
    ):
      | { ok: true; provider: ProviderMatch }
      | { ok: false; error: McpToolResult } {
      const matches = findProvidersOfferingSkill(
        deps.cache,
        args.skillId,
        args.serviceSlug,
      );
      if (args.providerTokenId) {
        const parsed = parseBigIntArg(args.providerTokenId, "providerTokenId");
        if (!parsed.ok) return { ok: false, error: parsed.error };
        const found = matches.find((m) => m.agentId === parsed.value);
        if (!found) {
          return {
            ok: false,
            error: errorJson({
              code: "skill_not_offered_by_provider",
              message: `provider ${args.providerTokenId} does not offer skill '${args.skillId}'`,
            }),
          };
        }
        return { ok: true, provider: found };
      }
      if (matches.length === 0) {
        return {
          ok: false,
          error: errorJson({
            code: "skill_not_found",
            message: `no whitelisted provider offers skill '${args.skillId}'`,
          }),
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: errorJson({
            code: "ambiguous_provider",
            message: `multiple providers offer skill '${args.skillId}'`,
            details: {
              providerTokenIds: matches.map((m) => m.agentId.toString()),
            },
          }),
        };
      }
      return { ok: true, provider: matches[0]! };
    }

    async function runBuyServiceX402Retry(
      args: BuyServiceArgs,
      extra: { _meta?: Record<string, unknown> },
    ): Promise<McpToolResult | null> {
      const metaPaymentRaw = extra._meta?.["x402/payment"];
      let inboundPayload: PaymentPayload | undefined =
        (args.paymentPayload as unknown as PaymentPayload | undefined) ??
        undefined;
      if (!inboundPayload && typeof metaPaymentRaw === "string") {
        try {
          inboundPayload = JSON.parse(
            Buffer.from(metaPaymentRaw, "base64").toString("utf8"),
          ) as PaymentPayload;
        } catch {
          return errorJson({
            code: "invalid_meta_payment",
            message:
              "_meta['x402/payment'] is not valid base64-encoded JSON",
            recoverable: true,
            next_action:
              "Encode the PaymentPayload JSON as base64 and resend, or pass `paymentPayload` directly as a tool argument.",
          });
        }
      }
      if (!inboundPayload) return null;

      const reqs = args.paymentRequirements as
        | PaymentRequirements
        | undefined;
      const serviceRefRaw = reqs?.extra?.daski?.serviceRef;
      if (typeof serviceRefRaw !== "string" || !HEX_32.test(serviceRefRaw)) {
        return errorJson({
          code: "BAD_INPUT",
          message:
            "Cannot locate the stored challenge. Pass `paymentRequirements` " +
            "alongside `paymentPayload` so the gateway can read serviceRef.",
          recoverable: true,
          next_action:
            "Echo the paymentRequirements you received in the first call and retry.",
        });
      }
      const challenge = await deps.queries.getChallengeByRef(
        serviceRefRaw.toLowerCase() as Hex,
      );
      if (!challenge) {
        return errorJson({
          code: "CHALLENGE_NOT_FOUND",
          message: "no challenge found for the given serviceRef",
          details: { serviceRef: serviceRefRaw },
        });
      }
      if (args.serviceArgs === undefined) {
        return errorJson({
          code: "QUOTE_REQUEST_ARGS_MISSING",
          message:
            "serviceArgs is required on a signed retry so the gateway can " +
            "verify the request still matches the provider quote.",
          recoverable: true,
          next_action:
            "Retry with the same serviceArgs used when the payment challenge was created.",
        });
      }
      if (!challenge.quoteRequestHash) {
        return errorJson({
          code: "QUOTE_CREDENTIALS_MISSING",
          message: "stored challenge is missing its quote requestHash",
        });
      }
      const normalizedRetry = validateAndNormalizeServiceArgs(
        args.serviceArgs,
        [],
      );
      if (!normalizedRetry.ok) return normalizedRetry.error;
      let retryRequestHash: Hex;
      try {
        retryRequestHash = computeRequestHash(normalizedRetry.args);
      } catch {
        return errorJson({
          code: "BAD_INPUT",
          message: "serviceArgs cannot be canonically encoded",
          recoverable: true,
        });
      }
      if (
        retryRequestHash.toLowerCase() !==
        challenge.quoteRequestHash.toLowerCase()
      ) {
        return errorJson({
          code: "QUOTE_REQUEST_MISMATCH",
          message:
            "serviceArgs do not match the requestHash committed by the provider quote",
          recoverable: true,
          next_action:
            "Retry with the exact serviceArgs used when the payment challenge was created.",
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
          challenge,
          paymentPayload: inboundPayload,
          registration: args.registration,
        },
      );
      if (coordinated.kind === "registration-required") {
        return errorJson({
          code: "registration_required",
          message:
            "this challenge was issued for an unregistered wallet " +
            "(buyerTokenId=0). Pass `registration` with a signed " +
            "RegisterAgent payload — see registrationPrep in the " +
            "first response.",
          recoverable: true,
          next_action:
            "Sign registrationPrep.eip712TypedData and pass the signature in `registration`.",
        });
      }
      if (coordinated.kind === "invalid-registration") {
        return errorJson({
          code: "invalid_registration",
          message: coordinated.message,
        });
      }
      const settleResult = coordinated.result;

      if (!settleResult.ok) {
        return errorJson({
          code: settleResult.errorReason,
          message: settleResult.message,
          details: {
            transaction: settleResult.response.transaction,
            payer: settleResult.response.payer,
          },
        });
      }
      const settlement = settleResult.response;

      // Standardized x402 paymentResponse — base64(SettlementResponse)
      // mirrored from the spec's `X-PAYMENT-RESPONSE` header.
      const paymentResponseB64 = Buffer.from(
        JSON.stringify(settlement),
      ).toString("base64");
      const responseMeta: Record<string, unknown> = {
        "x402/paymentResponse": paymentResponseB64,
      };

      // Task dispatch remains a separate signed-envelope step owned by
      // daski_submit_task. Return the settlement context it needs.
      return json(
        {
          success: true,
          kind: "settled",
          settled: true,
          transaction: settlement.transaction,
          network: settlement.network,
          payer: settlement.payer,
          paymentId: settlement.daski?.paymentId ?? null,
          serviceRef: settlement.daski?.serviceRef ?? serviceRefRaw,
          providerTokenId: settlement.daski?.providerTokenId ?? null,
          buyerTokenId: settlement.daski?.buyerTokenId ?? null,
          amount: settlement.daski?.amount ?? null,
          providerA2AUrl: settlement.daski?.providerA2AUrl ?? null,
          skillId: challenge.skillId,
          registered: settlement.daski?.registered ?? false,
          next_action:
            "Call daski_submit_task with the returned serviceRef, " +
            "transactionHash, paymentId, and buyerTokenId. The first call " +
            "(no envelopeAuth) returns the typed-data to sign; the second " +
            "call dispatches the task.",
        },
        responseMeta,
      );
    }

    async function runSynchronousFreeSkill(
      ctx: BuyServiceCtx,
      endpoint: string,
      responseKind: string,
    ): Promise<McpToolResult> {
      const targetUrl = ctx.providerA2AUrl.replace(/\/a2a(?=\/|$)/, endpoint);
      const post = await a2aPostJson<Record<string, unknown>>(
        targetUrl,
        ctx.serviceArgs,
        {
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxBytes: A2A_RESPONSE_MAX_BYTES,
        },
      );
      if (!post.ok) {
        return providerErrorFromFailure(post, targetUrl);
      }
      const body = sanitizeProviderValue(post.body);
      if (!post.raw.ok) {
        return errorJson({
          code: "PROVIDER_ERROR",
          message:
            (body.error as { message?: string } | undefined)?.message ??
            `${ctx.args.skillId} returned HTTP ${post.status}`,
        });
      }
      // Provider fields land at the top level; the wrapper's keys
      // (kind, providerTokenId, etc.) win so the agent-facing
      // discriminator stays stable. Empty plan signals "no further
      // steps; the answer is in the top-level fields."
      return json({
        ...body,
        kind: responseKind,
        providerTokenId: ctx.provider.agentId.toString(),
        providerA2AUrl: ctx.providerA2AUrl,
        skillId: ctx.args.skillId,
        chainId: deps.config.chainId,
        network: deps.config.network,
        plan: { steps: [] },
      });
    }

    function buildFreeSkillPlan(
      ctx: BuyServiceCtx,
      flags: {
        isOpenFree: boolean;
        requiresCapability: boolean;
        requiresAssetOwnership: boolean;
      },
    ): McpToolResult {
      const { args, provider, providerA2AUrl, serviceArgs } = ctx;
      const { isOpenFree, requiresCapability, requiresAssetOwnership } = flags;
      const steps: Array<{ toolName: string; hint: string; args: unknown }> = [];
      // Envelope auth: required for any non-open-free skill. We collapse
      // build+submit into a single daski_submit_task two-call exchange:
      // - First call (no envelopeAuth) → returns typed-data + messageId.
      // - Sign the typed-data with the buyer wallet.
      // - Second call (with envelopeAuth + matching messageId) → dispatch.
      //
      // Capability-gated skills use the provider's in-band two-call
      // pattern: the dispatched call comes back `input-required` with a
      // `capability_challenge` artifact instead of executing, and the
      // gateway bundles `nextEnvelopeAuthChallenge` — a pre-minted FRESH
      // envelope for the execute call, since envelopes are single-use.
      if (!isOpenFree) {
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "First call: omit envelopeAuth so the gateway returns the " +
            "A2ARequestAuthorization typed-data and a fresh messageId. " +
            "Pass buyerTokenId, skillId, paymentId, chainId, serviceArgs.",
          args: {
            providerA2AUrl,
            skillId: args.skillId,
            paymentId: args.paymentId ?? "0",
            chainId: deps.config.chainId,
            buyerTokenId: args.buyerTokenId,
            serviceArgs,
          },
        });
      }
      steps.push({
        toolName: isOpenFree ? "daski_submit_task" : "<your-wallet>.signTypedData",
        hint: isOpenFree
          ? "Dispatch directly. No paymentId, serviceRef, or " +
            "transactionHash, and no envelopeAuth. Open-free skills " +
            "complete synchronously: the result (artifacts + " +
            "statusMessage) is returned inline in this call's response " +
            "— DO NOT call daski_get_task_status, the taskId is " +
            "non-persistent."
          : "Sign the eip712TypedData returned by the first daski_submit_task " +
            "call with the buyer's agent wallet.",
        args: isOpenFree
          ? {
              providerA2AUrl,
              skillId: args.skillId,
              ...(args.paymentId ? { paymentId: args.paymentId } : {}),
              chainId: deps.config.chainId,
              serviceArgs,
            }
          : { typedData: "<from previous daski_submit_task.eip712TypedData>" },
      });
      if (!isOpenFree && !requiresCapability) {
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "Second call: pass envelopeAuth: { signature, authorization } and " +
            "the SAME messageId returned by the first call. The gateway " +
            "forwards the task to the provider over A2A.",
          args: {
            providerA2AUrl,
            skillId: args.skillId,
            ...(args.paymentId ? { paymentId: args.paymentId } : {}),
            chainId: deps.config.chainId,
            serviceArgs,
            messageId: "<from first daski_submit_task call>",
            envelopeAuth: "<signed envelope from sign step>",
          },
        });
      }
      if (!isOpenFree && requiresCapability) {
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "Second call: pass envelopeAuth: { signature, authorization } " +
            "and the SAME messageId from the first call. This skill is " +
            "capability-gated, so the provider does NOT execute yet — it " +
            `returns state 'input-required' with a capability_challenge ` +
            "artifact containing the provider-issued typed-data plus " +
            "nextEnvelopeAuthChallenge, a pre-minted FRESH envelope for " +
            "the execute call (envelopes are single-use; reusing this " +
            "call's messageId is rejected as ENVELOPE_REPLAY).",
          args: {
            providerA2AUrl,
            skillId: args.skillId,
            ...(args.paymentId ? { paymentId: args.paymentId } : {}),
            chainId: deps.config.chainId,
            serviceArgs,
            messageId: "<from first daski_submit_task call>",
            envelopeAuth: "<signed envelope from sign step>",
          },
        });
        steps.push({
          toolName: "<your-wallet>.signTypedData",
          hint:
            "Sign BOTH typed-datas from the previous response with the " +
            "buyer agent wallet: the provider-issued capability " +
            "challenge (in the capability_challenge artifact) and " +
            "nextEnvelopeAuthChallenge.eip712TypedData.",
          args: {
            typedData:
              "<capability_challenge eip712TypedData, then " +
              "nextEnvelopeAuthChallenge.eip712TypedData>",
          },
        });
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "Execute call: same skillId, paymentId, and serviceArgs, plus " +
            "capability: { signature, authorization } from the capability " +
            "challenge, envelopeAuth from nextEnvelopeAuthChallenge (NOT " +
            "the first envelope), its messageId, and the contextId " +
            "returned by the challenge call.",
          args: {
            providerA2AUrl,
            skillId: args.skillId,
            ...(args.paymentId ? { paymentId: args.paymentId } : {}),
            chainId: deps.config.chainId,
            serviceArgs,
            messageId: "<from nextEnvelopeAuthChallenge>",
            envelopeAuth: "<signed nextEnvelopeAuthChallenge>",
            capability: "<signed capability challenge>",
            contextId: "<from the challenge call>",
          },
        });
      }
      // Open-free skills are synchronous (submit_task returns artifacts
      // inline); ownership-gated skills create persisted tasks and need
      // polling.
      if (!isOpenFree) {
        steps.push({
          toolName: "daski_get_task_status",
          hint: "Poll until status is 'completed' or 'failed'.",
          args: { providerA2AUrl, taskId: "<from daski_submit_task>" },
        });
      }
      const freeArgWarnings = unknownServiceArgWarnings(
        provider.skillMeta,
        args.serviceArgs,
      );
      return json({
        kind: "free",
        freeKind: isOpenFree ? "open" : "ownership-gated",
        providerTokenId: provider.agentId.toString(),
        providerA2AUrl,
        skillId: args.skillId,
        paymentId: args.paymentId ?? null,
        requiresCapability,
        requiresAssetOwnership,
        chainId: deps.config.chainId,
        network: deps.config.network,
        ...(freeArgWarnings.length > 0 ? { warnings: freeArgWarnings } : {}),
        plan: { steps },
      });
    }

    async function runBuyServiceFreePath(
      ctx: BuyServiceCtx,
    ): Promise<McpToolResult> {
      const { args, provider, buyerAgentId } = ctx;
      const requiresAssetOwnership =
        provider.skillMeta.requiresAssetOwnership === true;
      const requiresCapability =
        provider.skillMeta.requiresCapability === true;
      const isOpenFree = !requiresAssetOwnership && !requiresCapability;

      // Synchronous direct-dispatch requires a declared directEndpoint.
      if (isOpenFree) {
        const sync = resolveSynchronousDispatch(provider.skillMeta);
        if (sync) return runSynchronousFreeSkill(ctx, sync.endpoint, sync.kind);
      }

      // Ownership-gated free skills need an existing agentId AND the
      // paymentId for the asset they act on. Open-free skills are
      // public reads — neither check applies.
      if (!isOpenFree) {
        if (buyerAgentId === 0n) {
          return errorJson({
            code: "buyer_not_registered",
            message:
              "wallet has no ERC-8004 agentId yet. Ownership-gated " +
              "free skills can't bootstrap registration — call " +
              "daski_register_agent (two calls: no signature → sign → " +
              "with signature) first, then retry.",
          });
        }
        if (!args.paymentId) {
          return errorJson({
            code: "payment_id_required",
            message:
              `Skill '${args.skillId}' acts on an asset you already ` +
              "purchased. Pass the paymentId of the original asset " +
              "purchase (e.g. register-domain) as `paymentId`.",
          });
        }
      }

      return buildFreeSkillPlan(ctx, {
        isOpenFree,
        requiresCapability,
        requiresAssetOwnership,
      });
    }

    async function runBuyServicePaidPath(
      ctx: BuyServiceCtx,
    ): Promise<McpToolResult> {
      const { args, provider, serviceArgs, buyerAgentId, buyerName } =
        ctx;
      const result = await createQuotedChallenge(
        {
          providerAgentId: provider.agentId,
          buyerAgentId,
          walletAddress: args.walletAddress.toLowerCase() as Hex,
          skillId: args.skillId,
          serviceSlug: args.serviceSlug,
          serviceArgs,
          amountLimit: args.amount,
        },
        {
          config: deps.config,
          cache: deps.cache,
          queries: deps.queries,
          reader: deps.reader,
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
        },
      );
      if (!result.ok) {
        const ignoredArgWarnings =
          result.error.code === "quote_validation_failed"
            ? unknownServiceArgWarnings(provider.skillMeta, args.serviceArgs)
            : [];
        return errorJson({
          code: result.error.code,
          message:
            ignoredArgWarnings.length > 0
              ? `${ignoredArgWarnings.join(" ")} ${result.error.message}`
              : result.error.message,
          details: {
            ...(result.error.details ?? {}),
            ...(ignoredArgWarnings.length > 0
              ? { warnings: ignoredArgWarnings }
              : {}),
          },
          recoverable: result.error.recoverable,
          next_action: result.error.nextAction,
        });
      }
      const r = result.value.requirements;
      const quoteNotes = result.value.quoteNotes;

      // Fresh wallets get a RegisterAgent prep block alongside the
      // payment so the agent can sign both typed-data blocks back to
      // back, then submit them atomically via daski_settle_payment.
      const isAtomic = buyerAgentId === 0n;
      let registrationPrep: unknown = null;
      // Display name baked into registrationPrep's agentURI — caller's
      // `name` when given, wallet-derived `buyer-<last6>` otherwise. Kept
      // out of the try block so the plan step below can reference it.
      let registrationName: string | null = null;
      if (isAtomic) {
        const prepared = await prepareRegistration(identityDeps, {
          walletAddress: args.walletAddress,
          name: buyerName,
          deadlineSeconds: 3600,
        });
        if (!prepared.ok) {
          const { code, message, ...details } = prepared.error;
          return errorJson({
            code,
            message,
            ...(Object.keys(details).length > 0 ? { details } : {}),
          });
        }
        registrationPrep = prepared.value;
        registrationName =
          typeof prepared.value.resolvedName === "string"
            ? prepared.value.resolvedName
            : null;
      }

      const steps: Array<{ toolName: string; hint: string; args: unknown }> = [];
      steps.push({
        toolName: "<your-wallet>.signTypedData",
        hint:
          "Pass paymentRequirements.extra.daski.eip712TypedData to " +
          "your wallet's signTypedData tool. AgentKit, CDP Wallet " +
          "MCP, MetaMask Snap, viem accounts all support this.",
        args: { typedData: r.extra.daski.eip712TypedData },
      });
      if (isAtomic) {
        steps.push({
          toolName: "<your-wallet>.signTypedData",
          hint:
            "Also sign registrationPrep.eip712TypedData with the SAME " +
            "wallet. The result is the `registration.signature` you'll " +
            "pass to daski_settle_payment alongside the payment payload. " +
            (buyerName
              ? `This registers the wallet's display name as '${registrationName}'.`
              : `Signing this registers the wallet under the default name ` +
                `'${registrationName}' — to appear under a real display name ` +
                `instead, re-call daski_buy_service with \`name\` set to the ` +
                `name of your choice BEFORE signing.`),
          args: {
            typedData: (registrationPrep as { eip712TypedData: unknown })
              .eip712TypedData,
          },
        });
      }
      steps.push({
        toolName: "daski_settle_payment",
        hint: isAtomic
          ? "Atomic register-and-settle: pass paymentPayload + " +
            "paymentRequirements + registration: { agentURI, deadline, " +
            "signature } where the signature is from the second wallet " +
            "sign step. Both registration and settlement go on-chain in " +
            "one tx — if either fails, neither happens."
          : "Assemble paymentPayload = { x402Version: 1, scheme, " +
            "network, payload: { signature, authorization: <typedData.message> } } " +
            "and pass it with the original paymentRequirements.",
        args: {
          paymentPayload: "<assembled from signature + typedData.message>",
          paymentRequirements: r,
          ...(isAtomic
            ? {
                registration: {
                  agentURI: "<from registrationPrep.agentURI>",
                  deadline: "<from registrationPrep.deadline>",
                  signature: "<from second wallet sign step>",
                },
              }
            : {}),
        },
      });
      steps.push({
        toolName: "daski_submit_task",
        hint: "Use serviceRef + transactionHash from daski_settle_payment.",
        args: {
          providerA2AUrl: result.value.challenge.providerA2AUrl,
          skillId: args.skillId,
          serviceRef: result.value.challenge.serviceRef,
          paymentId: "<from daski_settle_payment>",
          transactionHash: "<from daski_settle_payment>",
          chainId: deps.config.chainId,
          serviceArgs,
        },
      });
      steps.push({
        toolName: "daski_get_task_status",
        hint: "Poll until completed or failed.",
        args: {
          providerA2AUrl: result.value.challenge.providerA2AUrl,
          taskId: "<from daski_submit_task>",
        },
      });

      // Reputation step. Buyer's confirmation attestation tells the
      // network whether the delivered work matched intent. Counters
      // on ReputationStorage update accordingly. Gateway facilitator
      // pays gas; buyer just signs the EAS Attest typed-data.
      //
      // Two-call pattern via daski_confirm_delivery: first call (no
      // signature) returns the EAS Attest typed-data; second call (with
      // signature) submits the attestation on-chain.
      steps.push({
        toolName: "daski_confirm_delivery",
        hint:
          "First call: after daski_get_task_status reports state='completed' " +
          "(or 'failed'), call this WITHOUT signature to fetch the EAS Attest " +
          "typed-data. Use confirmation:'Confirmed' for a positive review, " +
          "'NotConfirmed' for a negative one.",
        args: {
          paymentId: "<from daski_settle_payment>",
          confirmation: "Confirmed",
          attester: args.walletAddress.toLowerCase(),
        },
      });
      steps.push({
        toolName: "<your-wallet>.signTypedData",
        hint:
          "Sign the eip712TypedData returned by daski_confirm_delivery's " +
          "first call with the SAME wallet that paid (the EAS attestation " +
          "must come from that address). Extract { v, r, s } from the signature.",
        args: { typedData: "<from daski_confirm_delivery.eip712TypedData>" },
      });
      steps.push({
        toolName: "daski_confirm_delivery",
        hint:
          "Second call: submit the v/r/s plus the deadline echoed from the " +
          "first call. Gateway facilitator relays the delegated EAS attestation; " +
          "buyer pays no gas. Bumps the provider's confirmed/notConfirmed " +
          "counter on ReputationStorage.",
        args: {
          paymentId: "<from daski_settle_payment>",
          confirmation: "Confirmed",
          attester: args.walletAddress.toLowerCase(),
          deadline: "<from first daski_confirm_delivery call>",
          signature: { v: "<v>", r: "<r>", s: "<s>" },
        },
      });

      // §1.1 — also surface paymentRequirements via _meta so x402-mcp
      // clients (and indexers like x402scan) recognize the challenge
      // without reading Daski-specific fields.
      const paymentRequiredB64 = Buffer.from(JSON.stringify(r)).toString(
        "base64",
      );
      const paidArgWarnings = unknownServiceArgWarnings(
        provider.skillMeta,
        args.serviceArgs,
      );
      // `name` only applies to the fresh-wallet atomic registration. Warn
      // rather than silently drop it (same policy as unknown serviceArgs)
      // so the agent doesn't believe it just renamed itself.
      if (!isAtomic && buyerName) {
        paidArgWarnings.push(
          `\`name\` was ignored — this wallet is already registered as ` +
            `agentId ${buyerAgentId.toString()}, and display-name changes ` +
            `after registration are outside the gateway registration flow.`,
        );
      }
      return json(
        {
          kind: "paid",
          atomic: isAtomic,
          providerTokenId: provider.agentId.toString(),
          providerA2AUrl: result.value.challenge.providerA2AUrl,
          skillId: args.skillId,
          serviceArgs,
          chainId: deps.config.chainId,
          network: deps.config.network,
          ...(paidArgWarnings.length > 0 ? { warnings: paidArgWarnings } : {}),
          acceptedToken: {
            address: deps.config.usdcAddress,
            name: deps.config.usdcName,
            version: deps.config.usdcVersion,
            chainId: deps.config.chainId,
            network: deps.config.network,
          },
          quoteNotes,
          // Signed provider quote backing this challenge. The challenge's
          // serviceRef IS quote.serviceRef; sign + settle + submit before
          // quoteExpiresAt (provider TTL ~120s) or re-run this tool for a
          // fresh quote. daski_submit_task forwards the credentials
          // automatically.
          quote: {
            quoteId: result.value.challenge.quoteId,
            expiresAt: result.value.challenge.quoteExpiresAt?.toISOString(),
          },
          legal: r.extra.daski.legal,
          agentAuthority: r.extra.daski.agentAuthority,
          purchaseNotice: r.extra.daski.purchaseNotice,
          paymentRequirements: r,
          registrationPrep,
          plan: { steps },
        },
        {
          "x402/paymentRequired": paymentRequiredB64,
          "x402/version": X402_VERSION,
        },
      );
    }

    // ── Orchestrator ─────────────────────────────────────────────────

    server.registerTool(
      "daski_buy_service",
      {
        description: [
          "**Start here for any paid Daski service.** Validates inputs, prepares the USDC payment, and (after wallet signing) settles on-chain. Pair with `daski_submit_task` to dispatch the work — settlement and dispatch are separate calls so a failure in one doesn't half-commit the other.",
          "Your Operator is the legal party. Payment authorization after the final purchase notice binds the Operator to the linked Daski and Provider Terms.",
          "",
          "When to use:",
          "- You have a `providerTokenId` + `skillId` from `daski_search_services` and want to actually run a paid skill.",
          "- This is your default tool for any priced service. Always prefer it over the manual primitives.",
          "",
          "When NOT to use:",
          "- The skill is free (`paymentRequired: false` in the search result) — call `daski_submit_task` directly.",
          "- You are polling an existing task — use `daski_get_task_status`.",
          "- You are submitting a buyer attestation — use `daski_confirm_delivery`.",
          "",
          "Inputs:",
          "- First call (no signature): `providerTokenId`, `serviceSlug`, `skillId`, `serviceArgs` (per the skill's `requiredFields`), `walletAddress`, and `name`. ALWAYS pass `name` on the first call for a wallet unless you have CONFIRMED it is already registered: an already-registered wallet ignores it with a harmless `name was ignored` warning, while omitting it on a fresh wallet and adding it after seeing `atomic: true` forces a wasteful second quote. On a fresh wallet `name` becomes registration-time metadata for the agentId minted with the purchase — derive it from your PRINCIPAL's business (ask if unclear), never from the provider or any counterparty.",
          "- Second call (signed retry): the same inputs plus `paymentPayload`, `paymentRequirements`, and (for fresh wallets) `registration`.",
          "- Entity formation: `managementType` and the matching `members` / `managers` arrays are TOP-LEVEL `serviceArgs` keys. There is NO `officials` or `officialsByClassification` wrapper; nesting them silently discards the fields and the quote rejects them as missing. Flat-or-nested normalization applies ONLY to contact roles (`registrant` / `admin` / `tech` / `billing`).",
          "",
          "Returns:",
          "- First call: `paymentRequirements` (contains `extra.daski.eip712TypedData` to sign) plus an optional `registrationPrep` block (sign this too on first-ever purchase from a fresh wallet) and a `plan[]` outlining the remaining tool calls.",
          "- Second call: `{ paymentId, transactionHash, serviceRef, providerA2AUrl, buyerTokenId, settled: true }`. Settlement only — the task is dispatched by the next `daski_submit_task` call.",
          "",
          "Next step: `daski_submit_task` with the returned `serviceRef`, `transactionHash`, `paymentId`, and the `buyerTokenId` from THIS response — carry it forward explicitly. (Fallback if you lost it: pass `walletAddress` and the gateway auto-derives from the on-chain AgentIndex. Omitting BOTH is the most common BAD_INPUT cause on dispatch.)",
          "",
          "Fresh-wallet note: a wallet with no ERC-8004 agentId auto-registers on first purchase via a second signature, bundled into the same on-chain tx as the USDC payment. Watch for `registrationPrep` in the first response and sign both typed-data blocks before retrying. The newly-minted `buyerTokenId` comes back in the second-call response. Pass `name` on the first call to choose the registration-time display name — otherwise it defaults to `buyer-<last6>` derived from the wallet address.",
        ].join("\n"),
        inputSchema: {
          skillId: z.string(),
          serviceSlug: z
            .string()
            .describe(
              "Required service identifier from daski_search_services. " +
                "Skill IDs are only unique within a service.",
            ),
          walletAddress: z
            .string()
            .describe(
              "The exact address the wallet will sign with. Baked into " +
                "the typed-data — mismatch causes the signed payload to be " +
                "rejected on-chain. Use the lowercased checksum form your " +
                "wallet returns.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "First-call only, fresh wallets only. Display name for the " +
                "buyer agent minted on first purchase — pick the name you " +
                "want to be known by on receipts, buyer profiles, and the " +
                "Daski marketplace (max 64 chars, free-form, uniqueness " +
                "not required). Defaults to `buyer-<last6>` derived from " +
                "the wallet address. Ignored when the wallet already has " +
                "an agentId — this gateway only sets registration-time names, so set it on " +
                "the first purchase.",
            ),
          buyerTokenId: z
            .string()
            .optional()
            .describe(
              "Buyer's ERC-8004 agentId. Optional — if omitted the gateway " +
                "looks it up via the wallet, and routes to atomic " +
                "register-and-settle for fresh wallets.",
            ),
          providerTokenId: z
            .string()
            .describe(
              "Required. Resolve from `daski_search_services` so the gateway " +
                "matches your intent to a known provider. Building the " +
                "value by hand bypasses validation.",
            ),
          serviceArgs: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Skill-specific arguments. Per-skill required fields are " +
                "advertised in daski_search_services under " +
                "skills[].requiredFields. For entity formation, " +
                "`managementType` and `members`/`managers` MUST be top-level; " +
                "never put them under `officials` or " +
                "`officialsByClassification`. Contact fields ONLY (firstName, " +
                "lastName, email, …) accept either flat keys or a nested " +
                "object under `registrant`/`admin`/`tech`/`billing` — the " +
                "gateway normalizes both contact shapes. " +
                "Phone numbers (e.g. `registrantPhone`) MUST be E.164 with " +
                "no separators — pattern `^\\+[1-9]\\d{1,14}$` (e.g. " +
                "`+15555550100`, NOT `+1.555.555.0100` or `(555) 555-0100`). " +
                "Most provider-side validators reject formatted strings.",
            ),
          confirmationToken: z
            .string()
            .optional()
            .describe(
              "Required whenever serviceArgs carry phone field(s): the " +
                "first call fails with PHONE_CONFIRMATION_REQUIRED and a " +
                "token bound to the exact values. Echo the phone value(s) " +
                "to your principal (showing any normalization you applied), " +
                "get an explicit confirmation, then retry the SAME call " +
                "with this token. Changing a phone value invalidates it.",
            ),
          amount: z.string().optional(),
          paymentId: z
            .string()
            .optional()
            .describe(
              "For free ownership-gated skills only: paymentId of the " +
                "original asset purchase (e.g. register-domain).",
            ),
          // ── x402 paywalled-tool retry path (§1.1) ──────────────────────
          // When set, the gateway verifies and settles the payment, then
          // returns the context required by daski_submit_task. Also accepted
          // via request _meta["x402/payment"] (base64) for x402-mcp interop.
          paymentPayload: z
            .object({
              x402Version: z
                .literal(1)
                .describe(
                  "x402 protocol version. Currently `1`.",
                ),
              scheme: z
                .enum(SUPPORTED_SCHEMES)
                .describe(
                  "x402 settlement scheme. Currently only `exact` is " +
                    "supported (EIP-3009 transferWithAuthorization).",
                ),
              network: z
                .enum(SUPPORTED_NETWORKS)
                .describe(
                  "Lowercased Base network identifier matching `chainId`.",
                ),
              payload: z.object({
                signature: z.string(),
                authorization: z.record(z.string(), z.unknown()),
              }),
            })
            .passthrough()
            .optional()
            .describe(
              "Signed x402 PaymentPayload returned to the gateway after the " +
                "wallet signs paymentRequirements.extra.daski.eip712TypedData. " +
                "Triggers verify+settle only. Required when retrying " +
                "after a paymentRequirements challenge.",
            ),
          paymentRequirements: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "The original paymentRequirements echoed back so the gateway " +
                "can locate the stored challenge by serviceRef. Required " +
                "alongside paymentPayload.",
            ),
          registration: z
            .object({
              agentURI: z.string(),
              deadline: z.string(),
              signature: z.string(),
            })
            .optional()
            .describe(
              "Required when paymentRequirements.extra.daski.settlementMode " +
                "=== 'atomic-register' (fresh wallet). Get the typed-data " +
                "from registrationPrep in the first response, sign with the " +
                "same wallet, then pass the resulting hex signature as " +
                "`registration.signature` (with `agentURI` and `deadline` " +
                "echoed verbatim).",
            ),
        },
        annotations: {
          // First call (no paymentPayload) is read-only — returns
          // paymentRequirements + plan with no side effects. Retry path
          // (with paymentPayload) settles on-chain. Idempotent across
          // retries because the EIP-3009 nonce makes the second submit a
          // no-op (returns the cached settlement).
          title: "Buy a Daski service",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        if (!HEX_ADDR.test(args.walletAddress)) {
          return errorJson({
            code: "BAD_INPUT",
            message: "walletAddress must be a 20-byte hex address",
          });
        }

        // §1.1 x402 retry path. When paymentPayload arrives (arg or
        // _meta["x402/payment"]), verify+settle runs before returning the
        // dispatch context. The helper returns null on the read-only first
        // leg so we fall through to plan-building.
        const retry = await runBuyServiceX402Retry(args, extra);
        if (retry !== null) return retry;

        // Optional buyer display name for the atomic registration.
        // First-call only — on the retry above the signed
        // registration.agentURI is already the source of truth, so an
        // echoed `name` is simply unused there. Sanitize before any
        // provider round-trip; empty string means "not provided", same
        // as the /register-prep resolver.
        let buyerName: string | undefined;
        if (args.name != null && args.name !== "") {
          const sanitized = sanitizeBuyerName(args.name);
          if (!sanitized.ok) {
            return errorJson({
              code: "BAD_INPUT",
              message: `name: ${sanitized.error}`,
              recoverable: true,
              next_action:
                "Fix `name` (max 64 chars, no control characters) and " +
                "retry, or omit it to accept the wallet-derived default.",
            });
          }
          buyerName = sanitized.name;
        }

        const lookup = resolveBuyServiceProvider(args);
        if (!lookup.ok) return lookup.error;
        const provider = lookup.provider;

        // §3.2 — accept both flat and nested registrant/admin/tech/
        // billing shapes (OpenSRS/Name.com vs Namecheap). Helper hoists
        // nested role objects to the top level before checking
        // requiredFields.
        const requiredFields = Array.isArray(provider.skillMeta.requiredFields)
          ? (provider.skillMeta.requiredFields as string[])
          : [];
        const validated = validateAndNormalizeServiceArgs(
          args.serviceArgs,
          requiredFields,
        );
        if (!validated.ok) return validated.error;
        const serviceArgs = validated.args;

        // Fast-fail E.164 phone validation. The provider's quote endpoint rejects
        // formatted phones too, but catching them in the gateway saves
        // a network round-trip and produces a clearer agent-side error.
        // Strict E.164: leading `+`, country code 1-9, then 1-14
        // digits, no separators.
        const phoneError = checkPhoneFields(serviceArgs);
        if (phoneError) return phoneError;

        // Format above, CONFIRMATION here: a validly-E.164 number the
        // agent normalized silently is exactly what lands wrong on public
        // WHOIS. Plan path only — the x402 retry returned earlier, so a
        // signed payment is never blocked behind this gate.
        const confirmError = checkPhoneConfirmation(
          serviceArgs,
          args.confirmationToken,
        );
        if (confirmError) return confirmError;

        // Resolve buyerAgentId. A non-zero caller-supplied value wins;
        // missing OR an explicit "0" both fall through to the on-chain
        // lookup. Treating "0" as a valid override would route an
        // already-registered wallet down atomic register-and-settle and
        // burn the buyer's USDC re-minting an agentId they already have
        // (or surface as a bare "execution reverted" when registerWithSig
        // sees a stale nonce). AgentIndex.resolve (via agentOfWallet) is
        // the single source of truth — let it speak.
        let parsedBuyerTokenId: bigint | null = null;
        if (args.buyerTokenId) {
          const p = parseBigIntArg(args.buyerTokenId, "buyerTokenId");
          if (!p.ok) return p.error;
          parsedBuyerTokenId = p.value;
        }
        let buyerAgentId: bigint;
        if (parsedBuyerTokenId !== null && parsedBuyerTokenId !== 0n) {
          buyerAgentId = parsedBuyerTokenId;
        } else {
          try {
            buyerAgentId = await deps.reader.agentOfWallet(
              args.walletAddress.toLowerCase() as Hex,
            );
          } catch (err) {
            return errorJson({
              code: "CHAIN_READ_FAILED",
              message: publicErrorMessage(
                "mcp.buyService.agentOfWallet",
                err,
                "buyer identity lookup failed",
              ),
            });
          }
        }

        const cached = deps.cache.get(provider.agentId);
        if (!cached) {
          return errorJson({
            code: "provider_not_found",
            message: "provider is not whitelisted",
          });
        }
        // The A2A endpoint of the CARD that offers this skill — on a
        // multi-service provider each service has its own /a2a/<slug>
        // endpoint, and posting a mailbox skill at the domain endpoint
        // would be rejected as an unknown skill.
        const providerA2AUrl = extractAgentCardUrl(provider.agentCard);
        if (!providerA2AUrl) {
          return errorJson({
            code: "pricing_unavailable",
            message: "provider agent card is missing url",
          });
        }

        const ctx: BuyServiceCtx = {
          args,
          provider,
          providerA2AUrl,
          serviceArgs,
          buyerAgentId,
          buyerName,
        };

        const paymentRequired =
          provider.skillMeta.paymentRequired !== false;
        if (
          !paymentRequired &&
          parsedBuyerTokenId !== null &&
          parsedBuyerTokenId !== 0n &&
          !(await walletControlsAgent(
            deps.reader,
            parsedBuyerTokenId,
            args.walletAddress.toLowerCase() as Hex,
          ))
        ) {
          return errorJson({
            code: "buyer_agent_not_controlled",
            message:
              "walletAddress does not control the supplied buyerTokenId",
          });
        }
        return paymentRequired
          ? runBuyServicePaidPath(ctx)
          : runBuyServiceFreePath(ctx);
      },
    );
  }

  // ── Resources ────────────────────────────────────────────────────────
  //
  // §5 — agents that already know a providerTokenId (from search_services)
  function buildServer(): McpServer {
    const server = new McpServer(
      { name: "daski-gateway", version: GATEWAY_VERSION },
      {
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          // Provider details are exposed as MCP Resources so clients can
          // lazy-load full Agent Cards without costing a tool slot.
          resources: { listChanged: false },
        },
        // Planted in the `initialize` response so the model sees the
        // canonical workflow before any individual tool description.
        instructions: SERVER_INSTRUCTIONS,
      },
    );
    instrumentToolCalls(server);
    registerTools(server);
    registerProviderResource(server, deps.cache, deps.config);
    return server;
  }

  return mountMcpHttpTransport({
    app,
    path: deps.config.mcpPath,
    createServer: buildServer,
    maxSessions: deps.maxSessions,
    maxSessionsPerClient: deps.maxSessionsPerClient,
    idleTtlMs: deps.sessionIdleTtlMs,
    sweepIntervalMs: deps.sessionSweepIntervalMs,
    allowedOrigins: [new URL(deps.config.publicUrl).origin],
  });
}
