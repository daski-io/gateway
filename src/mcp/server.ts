import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { Express, Request } from "express";
import type { Config } from "../config.js";
import { DASKI_A2A_EXTENSION_URI, X402_VERSION } from "../config.js";
import { buildEnvelopeAuth } from "../auth/envelope.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import type {
  CachedProvider,
  Hex,
  PaymentPayload,
  PaymentRequirements,
} from "../types.js";
import {
  formatForSkillDiscover,
  applyDiscoverFilters,
  extractAgentCardUrl,
  extractMarketplaceExtension,
} from "../discovery/format.js";
import { syncSkillEmbeddings } from "../discovery/embeddingSync.js";
import { safeFetch } from "../util/urlSafety.js";
import { normalizeState, normalizeRole } from "../util/a2aShape.js";
import { issuePaymentRequirements } from "../payment/requirements.js";
import { verifyAndSettle, verifyAndSettleWithRegistration } from "../payment/verify.js";
import { runConfirmDelivery } from "../payment/confirm.js";
import {
  defaultBuyerAgentURI,
  mcpError,
  mcpJson,
  normalizeContactFields,
  parseBigIntArg,
  validateAndNormalizeServiceArgs,
  type McpToolResult,
} from "./util.js";
import {
  a2aPostJson,
  guardProviderUrl,
  providerErrorFromFailure,
} from "./a2a.js";

// JSON response cap on provider A2A calls. Real responses are <50 KB; 1 MB
// is generous enough for unusual artifact payloads while still protecting
// against a malicious provider serving a multi-GB JSON body to OOM us.
const A2A_RESPONSE_MAX_BYTES = 1024 * 1024;
// Hard cap on bytes accepted from an SSE stream — pairs with the per-event
// timeout below so a stuck or hostile stream can't exhaust memory.
const SSE_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
const SSE_MAX_EVENTS = 1000;

// ── Tool surface ──────────────────────────────────────────────────────────
//
// The MCP is wallet-agnostic. Signing belongs to the agent's wallet — the
// gateway never sees a private key. Tools that need a signature take the
// signed result as input and verify on-chain (settle, confirm). Tools that
// produce signing material return EIP-712 typed-data ready for any wallet's
// generic signTypedData (purchase, prepare-confirm, prepare-dns-capability).

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
}

export interface McpWiring {
  sessionCount(): number;
  close(): Promise<void>;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_32 = /^0x[0-9a-fA-F]{64}$/;
const DEC_POSITIVE = /^[1-9][0-9]*$/;

// MCP enum sets — converted from free-text fields per the refactor brief so
// the model can't invent plausible-but-wrong values for cryptic protocol
// fields. Kept inline so any drift between docs and runtime is impossible.
const SUPPORTED_CHAIN_IDS = [8453, 84532] as const;
const SUPPORTED_NETWORKS = ["base", "base-sepolia"] as const;
const SUPPORTED_SCHEMES = ["exact"] as const;
const SUPPORTED_X402_VERSIONS = [1] as const;

// Server-level instructions — planted in the MCP `initialize` response and
// surfaced by Anthropic clients before any individual tool description. The
// canonical workflow lives here so the model has the map before it sees the
// individual tool surface.
const SERVER_INSTRUCTIONS = [
  "Daski lets your agent buy real-world business services — domain",
  "registration, LLC formation, hosting, email — by paying USDC on Base.",
  "The protocol is non-custodial; the gateway never holds funds.",
  "",
  "Canonical workflow:",
  "  1. daski_search_services    — find a provider",
  "  2. daski_buy_service        — pay (auto-registers fresh wallets)",
  "  3. daski_submit_task        — dispatch the work (or for free skills, call directly)",
  "  4. daski_get_task_status    — poll until 'completed' or 'failed'",
  "  5. daski_confirm_delivery   — leave an on-chain attestation (optional)",
  "",
  "Other tools (daski_register_agent, daski_purchase, daski_settle_payment)",
  "are advanced/manual paths. Use them only when daski_buy_service doesn't fit.",
  "",
  "Sandbox runs on Base Sepolia testnet (chainId 84532). Faucet USDC:",
  "https://faucet.circle.com/. Mainnet (chainId 8453) launches after the next",
  "batch of service categories goes live.",
].join("\n");

// Per-session marker carried on the McpServer instance so the tools/list
// override knows whether deprecated aliases should be visible. The
// /mcp POST handler reads `?include=deprecated=1` or
// `X-Daski-Include-Deprecated: 1` from the inbound request and sets this
// before `buildSession()` registers tools.
type DeprecationFlag = { includeDeprecated: boolean };

function requestWantsDeprecated(req: Request): boolean {
  const headerRaw = req.headers["x-daski-include-deprecated"];
  const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
  if (typeof header === "string" && header.trim() !== "" && header !== "0") {
    return true;
  }
  const q = req.query?.include;
  const qStr = Array.isArray(q) ? q[0] : q;
  if (typeof qStr === "string") {
    // Accept any of `?include=deprecated`, `?include=deprecated,foo`,
    // or `?include=1` — keep the matcher permissive so URL-typing slips
    // don't lock callers out.
    if (qStr.split(",").map((s) => s.trim()).includes("deprecated")) {
      return true;
    }
  }
  return false;
}

// Names of the deprecated tools — kept in one place so the
// tools/list filter, the deprecation-warning logger, and any future
// telemetry stay in sync.
const DEPRECATED_TOOL_NAMES = new Set<string>([
  "search_services",
  "daski_get_provider",
  "daski_build_envelope_auth",
  "daski_prepare_registration",
  "daski_register_buyer",
  "daski_prepare_confirm",
]);

// Replacement table emitted in the deprecation log so dashboards can
// aggregate "callers still on X" without parsing the log message.
const DEPRECATED_TOOL_REPLACEMENTS: Record<string, string> = {
  search_services: "daski_search_services",
  daski_get_provider: "daski://provider/{tokenId} (MCP Resource)",
  daski_build_envelope_auth: "daski_submit_task (first call without envelopeAuth)",
  daski_prepare_registration: "daski_register_agent (first call without signature)",
  daski_register_buyer: "daski_register_agent (second call with signature)",
  daski_prepare_confirm: "daski_confirm_delivery (first call without signature)",
};

function logDeprecatedToolCall(name: string): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "deprecated_tool_call",
      tool: name,
      replacement: DEPRECATED_TOOL_REPLACEMENTS[name] ?? null,
    }),
  );
}

// Mirrors the SDK's auto-generated `tools/list` payload using its own
// serialization helpers, so the override produced by `buildSession` matches
// the SDK's shape byte-for-byte. The SDK doesn't expose a public iterator
// over registered tools, so we read its private `_registeredTools` table
// directly — pinned by the SDK's semver range in package.json.
function listRegisteredTools(server: McpServer): Array<{
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registered = (server as any)._registeredTools as
    | Record<
        string,
        {
          enabled: boolean;
          title?: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: unknown;
          _meta?: Record<string, unknown>;
        }
      >
    | undefined;
  if (!registered) return [];
  const EMPTY_OBJECT_JSON_SCHEMA = { type: "object", properties: {} };
  return Object.entries(registered)
    .filter(([, tool]) => tool.enabled)
    .map(([name, tool]) => {
      let inputSchema: unknown = EMPTY_OBJECT_JSON_SCHEMA;
      if (tool.inputSchema) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const normalized = normalizeObjectSchema(tool.inputSchema as any);
        if (normalized) {
          inputSchema = toJsonSchemaCompat(normalized, {
            strictUnions: true,
            pipeStrategy: "input",
          });
        }
      }
      return {
        name,
        title: tool.title,
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      };
    });
}

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

// Translates an HTTP error body of the shape `{ error: { code, message, ... } }`
// (used by /register-prep, /confirm-prep, /capability-prep, /register) into
// the standardized MCP error envelope. Falls back to a generic UPSTREAM_ERROR
// when the body shape is unexpected.
const upstreamErrorJson = (body: unknown): McpToolResult => {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof err?.code === "string" ? err.code : "UPSTREAM_ERROR";
  const message =
    typeof err?.message === "string"
      ? err.message
      : "upstream gateway endpoint returned a non-OK response";
  const details: Record<string, unknown> = {};
  if (err && typeof err === "object") {
    for (const [k, v] of Object.entries(err)) {
      if (k !== "code" && k !== "message") details[k] = v;
    }
  }
  return errorJson({
    code,
    message,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
};

export async function createMcpServer(
  app: Express,
  deps: McpDeps,
): Promise<McpWiring> {
  const sessions = new Map<string, Session>();
  // Default to safeFetch (validates host + pins resolved IP at connect).
  // Tests inject deps.fetch with a mock that ignores SSRF; the loose
  // signature means a `(url, init) => Promise<Response>` mock satisfies
  // safeFetch's `(url, init?, preValidated?)` signature without changes.
  const a2aFetch: (
    u: string,
    i?: RequestInit,
  ) => Promise<Response> = deps.fetch ?? safeFetch;
  const a2aTimeoutMs = deps.a2aTimeoutMs ?? 10_000;

  function registerTools(server: McpServer) {
    // ── Discovery ────────────────────────────────────────────────────

    const SEARCH_SERVICES_INPUT_SCHEMA = {
      intent: z
        .string()
        .optional()
        .describe(
          "Free-text description of what the agent wants to do (e.g. " +
            "'register a .com domain'). Embedded with pgvector; ranked " +
            "by cosine similarity over every (provider, skill) pair in " +
            "the catalog.",
        ),
      category: z
        .string()
        .optional()
        .describe("Filter by provider category (e.g. domain-registration)."),
      maxPrice: z
        .number()
        .optional()
        .describe("Filter by max base price in USDC (not smallest units)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max providers to return. Default 10."),
    };

    type SearchServicesArgs = {
      intent?: string;
      category?: string;
      maxPrice?: number;
      limit?: number;
    };

    const searchServicesHandler = async (
      args: SearchServicesArgs,
    ): Promise<McpToolResult> => {
        const limit = args?.limit ?? 10;
        const all = deps.cache.getAll();
        const filtered = applyDiscoverFilters(all, {
          category: args?.category,
          maxPrice: args?.maxPrice,
        });

        // No intent → catalog mode (back-compat with daski_discover).
        if (!args?.intent || args.intent.trim().length === 0) {
          return json({
            acceptedToken: {
              address: deps.config.usdcAddress,
              name: deps.config.usdcName,
              version: deps.config.usdcVersion,
              chainId: deps.config.chainId,
              network: deps.config.network,
            },
            providers: formatForSkillDiscover(filtered).slice(0, limit),
            cachedAt: deps.cache.getLastRefresh()?.toISOString() ?? null,
          });
        }

        // Intent mode → embed, query pgvector, rank by best skill match
        // per provider. Falls back to catalog mode when the embedder is
        // disabled (e.g. tests with embedder:null).
        if (!deps.embedder) {
          return json({
            acceptedToken: {
              address: deps.config.usdcAddress,
              name: deps.config.usdcName,
              version: deps.config.usdcVersion,
              chainId: deps.config.chainId,
              network: deps.config.network,
            },
            providers: formatForSkillDiscover(filtered).slice(0, limit),
            cachedAt: deps.cache.getLastRefresh()?.toISOString() ?? null,
            note: "embedder disabled — returning unranked catalog",
          });
        }

        // Lazy-sync `skill_embeddings` against the current cache. Cheap
        // when nothing's changed (one indexed scan, no embeddings
        // recomputed). Keeps tests deterministic and prod self-healing.
        await syncSkillEmbeddings(deps.pool, filtered, deps.embedder);

        const queryVector = await deps.embedder.embed(args.intent);
        // Pull more skills than we need so a provider that wins on its
        // 4th-best skill still surfaces above one whose only skill is
        // borderline. 5×limit is generous at our scale.
        const hits = await deps.queries.searchSkillsByEmbedding(
          queryVector,
          Math.min(limit * 5, 250),
        );

        // Aggregate to best (lowest distance) hit per provider.
        const bestByProvider = new Map<string, { distance: number; skillId: string }>();
        for (const h of hits) {
          const key = h.providerAgentId.toString();
          const cur = bestByProvider.get(key);
          if (!cur || h.distance < cur.distance) {
            bestByProvider.set(key, {
              distance: h.distance,
              skillId: h.skillId,
            });
          }
        }

        const filteredIds = new Set(filtered.map((p) => p.agentId.toString()));
        const ordered = [...bestByProvider.entries()]
          .filter(([id]) => filteredIds.has(id))
          .sort((a, b) => a[1].distance - b[1].distance)
          .slice(0, limit);

        const cardById = new Map(
          filtered.map((p) => [p.agentId.toString(), p] as const),
        );
        const matchedProviders = ordered
          .map(([id]) => cardById.get(id))
          .filter((p): p is NonNullable<typeof p> => p !== undefined);
        const formatted = formatForSkillDiscover(matchedProviders);
        const matches = formatted.map((entry, i) => ({
          ...entry,
          match: {
            distance: ordered[i]![1].distance,
            bestSkillId: ordered[i]![1].skillId,
          },
        }));

        return json({
          acceptedToken: {
            address: deps.config.usdcAddress,
            name: deps.config.usdcName,
            version: deps.config.usdcVersion,
            chainId: deps.config.chainId,
            network: deps.config.network,
          },
          intent: args.intent,
          providers: matches,
          cachedAt: deps.cache.getLastRefresh()?.toISOString() ?? null,
        });
    };

    server.registerTool(
      "daski_search_services",
      {
        description: [
          "Find a provider on the Daski marketplace that can perform a real-world service for USDC (domain registration, LLC formation, hosting, email, etc.).",
          "",
          "When to use:",
          "- The user asks for any paid real-world action (\"register example.com\", \"form an LLC in Wyoming\", \"set up a mailbox\").",
          "- You need to discover what services exist before deciding which tool to call.",
          "- You want to compare providers by price or reputation.",
          "",
          "When NOT to use:",
          "- You already have a `providerTokenId` + `skillId` and just want to execute — go straight to `daski_buy_service`.",
          "- You are polling an existing task — use `daski_get_task_status`.",
          "",
          "Inputs: free-text `intent` ranked by vector similarity over the catalog; optional `category`, `maxPrice`, `limit`.",
          "Returns: ranked list of providers. Each entry has `tokenId`, `name`, `category`, `agentCardUrl`, `providerA2AUrl`, and a `skills[]` array. Each skill includes `id`, `description`, `requiredFields[]`, `paymentRequired`, `variablePricing`, and the asset/capability flags you need to plan the next call.",
          "Next step: `daski_buy_service` for paid skills, or `daski_submit_task` for free read-only skills like `check-availability` or `get-pricing`.",
        ].join("\n"),
        inputSchema: SEARCH_SERVICES_INPUT_SCHEMA,
        annotations: {
          title: "Find a Daski provider",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      searchServicesHandler,
    );

    // Deprecated alias — kept callable through the grace period so agents
    // that hardcoded the legacy name keep working while they migrate.
    // Hidden from `tools/list` unless the client opts in via
    // `?include=deprecated` or `X-Daski-Include-Deprecated: 1`.
    server.registerTool(
      "search_services",
      {
        description:
          "Deprecated alias for `daski_search_services`. Use the new name.",
        inputSchema: SEARCH_SERVICES_INPUT_SCHEMA,
        annotations: {
          title: "[Deprecated] Search Daski services",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        logDeprecatedToolCall("search_services");
        return searchServicesHandler(args);
      },
    );

    server.registerTool(
      "daski_get_provider",
      {
        description:
          "Deprecated alias. Read the MCP Resource `daski://provider/{tokenId}` " +
          "instead — same shape, no tool-budget cost. Kept callable for one " +
          "release cycle.",
        inputSchema: {
          providerTokenId: z.string(),
        },
        annotations: {
          title: "[Deprecated] Get Daski provider by tokenId",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        logDeprecatedToolCall("daski_get_provider");
        const parsed = parseBigIntArg(args.providerTokenId, "providerTokenId");
        if (!parsed.ok) return parsed.error;
        const provider = deps.cache.get(parsed.value);
        if (!provider) {
          return errorJson({
            code: "PROVIDER_NOT_FOUND",
            message: "provider is not whitelisted or not in cache",
          });
        }
        return json(formatForSkillDiscover([provider])[0]);
      },
    );

    // ── Purchase / settle / confirm ──────────────────────────────────
    //
    // Note: daski_check_availability was removed in v4. Agents reach
    // check-availability via daski_submit_task → provider's free A2A
    // skill (synchronous; the gateway's submit_task flattens artifacts
    // inline, so the answer arrives in one round trip). The gateway's
    // /availability HTTP route is preserved as a back-compat sibling
    // channel for legacy callers.

    server.registerTool(
      "daski_purchase",
      {
        description: [
          "**Advanced/manual.** Prefer `daski_buy_service` unless you're managing the payment lifecycle yourself (custom UIs, multi-leg signing flows, dry-run quotes).",
          "",
          "Open an x402 payment challenge for a specific (provider, skill) pair. Returns `paymentRequirements` with inline EIP-712 typed-data to sign. Pair with `daski_settle_payment` to finalize.",
          "",
          "When to use:",
          "- You explicitly want to separate quoting from settlement (e.g. to preview the price before signing).",
          "- You are building a custom UI on top of Daski.",
          "",
          "When NOT to use:",
          "- Anything else. `daski_buy_service` does this and more in one call.",
          "",
          "Inputs: `providerTokenId`, `buyerTokenId`, `walletAddress`; optional `skillId`, `amount` (atomic USDC units, defaults to skill base).",
          "Returns: `paymentRequirements` with `extra.daski.eip712TypedData` to sign.",
          "Next step: sign the typed-data, then call `daski_settle_payment`.",
        ].join("\n"),
        inputSchema: {
          providerTokenId: z.string(),
          buyerTokenId: z.string().describe("Buyer's ERC-8004 agentId."),
          walletAddress: z
            .string()
            .describe(
              "The exact address the wallet will sign with. Baked into the " +
                "typed-data — mismatch causes the signed payload to be " +
                "rejected on-chain. Use the lowercased checksum form your " +
                "wallet returns.",
            ),
          skillId: z.string().optional(),
          amount: z
            .string()
            .optional()
            .describe("Atomic USDC units. Defaults to skill base."),
        },
        annotations: {
          title: "Daski: open payment challenge",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        if (!HEX_ADDR.test(args.walletAddress)) {
          return errorJson({
            code: "BAD_INPUT",
            message: "walletAddress must be a 20-byte hex address",
          });
        }
        const parsedProvider = parseBigIntArg(args.providerTokenId, "providerTokenId");
        if (!parsedProvider.ok) return parsedProvider.error;
        const parsedBuyer = parseBigIntArg(args.buyerTokenId, "buyerTokenId");
        if (!parsedBuyer.ok) return parsedBuyer.error;
        const providerTokenId = parsedProvider.value;
        const buyerTokenId = parsedBuyer.value;
        const resource = `${deps.config.publicUrl}/purchase/${providerTokenId.toString()}`;
        const result = await issuePaymentRequirements(
          {
            providerTokenId,
            buyerTokenId,
            skillId: args.skillId,
            amount: args.amount,
            resource,
            walletAddress: args.walletAddress.toLowerCase() as Hex,
          },
          deps.config,
          deps.cache,
          deps.queries,
        );
        if (!result.ok) {
          return errorJson({ code: result.code, message: result.message });
        }
        return json({ paymentRequirements: result.requirements });
      },
    );

    server.registerTool(
      "daski_settle_payment",
      {
        description: [
          "**Advanced/manual.** Prefer `daski_buy_service` unless you called `daski_purchase` separately.",
          "",
          "Submit a signed x402 paymentPayload on-chain via the gateway facilitator. Atomic with agent registration when the buyer wallet has no ERC-8004 token yet.",
          "",
          "When to use:",
          "- You called `daski_purchase` separately and have a typed-data signature.",
          "- You are retrying a settlement after a transient error.",
          "",
          "When NOT to use:",
          "- You haven't called `daski_purchase` first.",
          "- You'd rather use the one-shot orchestrator — call `daski_buy_service`.",
          "",
          "Inputs: `paymentPayload` (`{ x402Version, scheme, network, payload }`), `paymentRequirements` (echo from `daski_purchase`); optional `registration` (required only for fresh wallets — get the typed-data from `daski_register_agent`, sign with the SAME wallet that signed the payment).",
          "Returns: `{ paymentId, transactionHash, serviceRef, providerA2AUrl, buyerTokenId }`.",
          "Next step: `daski_submit_task` with the returned `serviceRef`, `transactionHash`, and `paymentId`.",
        ].join("\n"),
        inputSchema: {
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
            .passthrough(),
          paymentRequirements: z.record(z.string(), z.unknown()),
          registration: z
            .object({
              agentURI: z
                .string()
                .describe(
                  "Echo verbatim the `agentURI` returned by " +
                    "`daski_register_agent`'s first call. Mutating it " +
                    "between calls invalidates the signature.",
                ),
              deadline: z.string(),
              signature: z.string(),
            })
            .optional()
            .describe(
              "Required only for fresh wallets (challenge.buyerTokenId === '0'). " +
                "Get the typed-data from `daski_register_agent`, sign with the " +
                "SAME wallet that signed the payment. Both will be submitted " +
                "in one atomic tx (the USDC payment is the Sybil tax for the " +
                "new agentId).",
            ),
        },
        annotations: {
          // Settlement is destructive (moves USDC on-chain) but idempotent:
          // EIP-3009 nonces are consumed on first use, so a retry of the
          // same payload reverts on-chain. Daski returns the cached
          // settlement instead of re-submitting.
          title: "Daski: settle payment",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
        const reqs = args.paymentRequirements as unknown as PaymentRequirements;
        const serviceRefRaw = (
          reqs?.extra as { daski?: { serviceRef?: string } } | undefined
        )?.daski?.serviceRef;
        if (typeof serviceRefRaw !== "string" || !HEX_32.test(serviceRefRaw)) {
          return errorJson({
            code: "BAD_INPUT",
            message:
              "paymentRequirements.extra.daski.serviceRef missing or malformed",
          });
        }
        const challenge = await deps.queries.getChallengeByRef(
          serviceRefRaw.toLowerCase() as Hex,
        );
        if (!challenge) {
          return errorJson({
            code: "CHALLENGE_NOT_FOUND",
            message: "no challenge found for the given serviceRef",
          });
        }

        const needsRegistration = challenge.buyerTokenId === 0n;
        if (needsRegistration && !args.registration) {
          return errorJson({
            code: "registration_required",
            message:
              "this challenge was issued for an unregistered wallet (" +
              "buyerTokenId=0). Pass `registration` with a signed " +
              "RegisterAgent payload — see daski_register_agent.",
          });
        }

        const result = needsRegistration
          ? await verifyAndSettleWithRegistration(
              {
                payload: args.paymentPayload as unknown as PaymentPayload,
                challenge,
              },
              {
                agentURI: args.registration!.agentURI,
                deadline: BigInt(args.registration!.deadline),
                signature: args.registration!.signature as Hex,
              },
              deps.config,
              deps.reader,
              deps.queries,
              new Date(),
              { fetchAgentCardFn: deps.buyerAgentCardFetch },
            )
          : await verifyAndSettle(
              {
                payload: args.paymentPayload as unknown as PaymentPayload,
                challenge,
              },
              deps.config,
              deps.reader,
              deps.queries,
            );

        if (!result.ok) {
          return errorJson({
            code: result.errorReason,
            message: result.message,
            details: {
              transaction: result.response.transaction,
              payer: result.response.payer,
            },
            recoverable: false,
          });
        }
        const r = result.response;
        return json({
          success: true,
          transaction: r.transaction,
          network: r.network,
          payer: r.payer,
          paymentId: r.daski?.paymentId ?? null,
          serviceRef: r.daski?.serviceRef ?? null,
          providerTokenId: r.daski?.providerTokenId ?? null,
          buyerTokenId: r.daski?.buyerTokenId ?? null,
          amount: r.daski?.amount ?? null,
          providerA2AUrl: r.daski?.providerA2AUrl ?? null,
          skillId: challenge.skillId,
          registered: r.daski?.registered ?? false,
        });
      },
    );

    const CONFIRM_DELIVERY_INPUT_SCHEMA = {
      paymentId: z
        .string()
        .describe(
          "Decimal string returned by `daski_buy_service` (or " +
            "`daski_settle_payment`). Do not construct manually — it's " +
            "an on-chain identifier the gateway issues at settlement time.",
        ),
      confirmation: z.enum(["Confirmed", "NotConfirmed"]),
      attester: z
        .string()
        .describe(
          "The buyer wallet that paid for the service. The EAS attestation " +
            "MUST come from this address; using a different wallet fails " +
            "the signature check.",
        ),
      deadlineSeconds: z
        .number()
        .optional()
        .describe(
          "First-call only. Signature expiry, seconds from now. Default 3600.",
        ),
      deadline: z
        .string()
        .optional()
        .describe(
          "Second-call only. Echo verbatim the `deadline` returned by the " +
            "first call — it's baked into the typed-data the wallet signed.",
        ),
      refUid: z.string().optional(),
      signature: z
        .object({
          v: z.number(),
          r: z.string(),
          s: z.string(),
        })
        .optional()
        .describe(
          "Second-call only. Omit to get back the EAS Attest typed-data the " +
            "wallet must sign; pass `{v,r,s}` (extracted from the signature) " +
            "to submit the attestation on-chain.",
        ),
    };

    type ConfirmDeliveryArgs = {
      paymentId: string;
      confirmation: "Confirmed" | "NotConfirmed";
      attester: string;
      deadlineSeconds?: number;
      deadline?: string;
      refUid?: string;
      signature?: { v: number; r: string; s: string };
    };

    const confirmDeliveryHandler = async (
      args: ConfirmDeliveryArgs,
    ): Promise<McpToolResult> => {
      // First call (no signature) → return typed-data the wallet signs.
      // Same shape as the legacy daski_prepare_confirm tool. The buyer
      // re-calls with `signature` + `deadline` to submit the attestation.
      if (!args.signature) {
        if (!HEX_ADDR.test(args.attester)) {
          return errorJson({
            code: "BAD_ATTESTER",
            message: "attester must be a 20-byte hex address",
          });
        }
        const qs = new URLSearchParams({
          confirmation: args.confirmation,
          attester: args.attester,
        });
        if (args.deadlineSeconds != null) {
          qs.set("deadlineSeconds", String(args.deadlineSeconds));
        }
        if (args.refUid) qs.set("refUid", args.refUid);
        const res = await fetch(
          `${deps.config.publicUrl}/confirm-prep/${encodeURIComponent(args.paymentId)}?${qs}`,
        );
        const body = await res.json();
        if (!res.ok) return upstreamErrorJson(body);
        return json(body);
      }

      // Second call (signature present) → submit the EAS attestation.
      if (!args.deadline) {
        return errorJson({
          code: "BAD_INPUT",
          message:
            "deadline is required alongside signature — echo the value " +
            "returned by the first call so the signed typed-data matches " +
            "what the resolver expects.",
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
      if (!result.ok) {
        return errorJson(result.error);
      }
      const { ok: _ok, ...rest } = result;
      return json(rest);
    };

    server.registerTool(
      "daski_confirm_delivery",
      {
        description: [
          "Leave a confirmed / not-confirmed attestation for a completed Daski purchase. Bumps the provider's on-chain reputation. The buyer pays no gas — the gateway facilitator relays the signed attestation.",
          "",
          "When to use:",
          "- After `daski_get_task_status` (or the final `daski_submit_task` response) shows `state: 'completed'` and the user is satisfied — submit `confirmation: 'Confirmed'`.",
          "- The work was delivered incorrectly or not at all — submit `confirmation: 'NotConfirmed'`.",
          "",
          "When NOT to use:",
          "- The task is still in progress — wait for `state: 'completed' | 'failed'`.",
          "- You're trying to dispute or refund — Daski attestations are reputational, not financial. There is no chargeback path; on-chain settlement is final.",
          "",
          "Inputs:",
          "- First call (no signature): `paymentId`, `attester` (the wallet that paid), `confirmation` (`'Confirmed' | 'NotConfirmed'`); optional `deadlineSeconds`, `refUid`.",
          "- Second call (signed retry): the same inputs plus `deadline` and `signature: { v, r, s }`.",
          "",
          "Returns:",
          "- First call: `{ eip712TypedData, deadline }`. Sign `eip712TypedData` with the SAME wallet that paid (the EAS attestation must come from that address). Extract `{ v, r, s }`.",
          "- Second call: `{ attestationUid, transactionHash, success: true }`.",
          "",
          "Next step: done. The provider's `ReputationStorage` counter is now bumped.",
        ].join("\n"),
        inputSchema: CONFIRM_DELIVERY_INPUT_SCHEMA,
        annotations: {
          // Two-call: first call is read-only (returns typed-data), second
          // call submits the attestation. The EAS resolver rejects a
          // duplicate confirmation for the same paymentId, so a retry of
          // the second call reverts on-chain.
          title: "Confirm Daski delivery",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      confirmDeliveryHandler,
    );

    // ── Standalone registration (advanced) ────────────────────────────
    //
    // Two-call: first call (no `signature`) returns RegisterAgent typed-data
    // for the wallet to sign; second call (with `signature`) submits via the
    // facilitator and returns the new agentId. Most buyers should NOT need
    // this — daski_buy_service auto-registers fresh wallets atomically.

    type RegisterAgentArgs = {
      walletAddress: string;
      name?: string;
      agentURI?: string;
      deadline?: string;
      deadlineSeconds?: number;
      signature?: string;
    };

    const registerAgentHandler = async (
      args: RegisterAgentArgs,
    ): Promise<McpToolResult> => {
      if (!HEX_ADDR.test(args.walletAddress)) {
        return errorJson({
          code: "BAD_WALLET",
          message: "walletAddress must be a 20-byte hex address",
        });
      }
      // First call (no signature) → return typed-data.
      if (!args.signature) {
        const qs = new URLSearchParams({ walletAddress: args.walletAddress });
        if (args.name != null) qs.set("name", args.name);
        if (args.agentURI != null) qs.set("agentURI", args.agentURI);
        if (args.deadlineSeconds != null) {
          qs.set("deadlineSeconds", String(args.deadlineSeconds));
        }
        const res = await fetch(`${deps.config.publicUrl}/register-prep?${qs}`);
        const body = await res.json();
        if (!res.ok) return upstreamErrorJson(body);
        return json(body);
      }
      // Second call → submit signed registration.
      if (!args.agentURI || !args.deadline) {
        return errorJson({
          code: "BAD_INPUT",
          message:
            "agentURI and deadline are required alongside signature — " +
            "echo the values returned by the first call so the signed " +
            "typed-data matches what the registry expects.",
        });
      }
      const res = await fetch(`${deps.config.publicUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: args.walletAddress,
          agentURI: args.agentURI,
          deadline: args.deadline,
          signature: args.signature,
        }),
      });
      const body = await res.json();
      if (!res.ok) return upstreamErrorJson(body);
      return json(body);
    };

    server.registerTool(
      "daski_register_agent",
      {
        description: [
          "**Advanced.** Register a fresh wallet as an ERC-8004 Daski agent without making a purchase. Most agents do NOT need this — `daski_buy_service` registers atomically on first purchase, free of gas. Use this only when you want a Daski identity ahead of any transaction (e.g. to claim a display name or read reputation).",
          "",
          "When to use:",
          "- The user wants a Daski identity before buying anything.",
          "- You're staking out a display name for a fresh wallet.",
          "",
          "When NOT to use:",
          "- The user is about to make a purchase — `daski_buy_service` bundles registration and payment into one tx.",
          "",
          "Inputs:",
          "- First call: `walletAddress`; optional `name` (max 64 chars, shown on receipts and in the marketplace UI).",
          "- Second call: `walletAddress`, `agentURI` (echo verbatim from the first call), `deadline`, `signature` (0x-prefixed hex from `signTypedData`).",
          "",
          "Returns:",
          "- First call: `{ eip712TypedData, agentURI, deadline }`. Sign `eip712TypedData` with the buyer wallet.",
          "- Second call: `{ buyerTokenId, transactionHash }`.",
          "",
          "Next step: done. The wallet now has an ERC-8004 agentId, viewable on the marketplace.",
        ].join("\n"),
        inputSchema: {
          walletAddress: z
            .string()
            .describe(
              "The exact address the wallet will sign with. Baked into the " +
                "typed-data — mismatch causes the signed payload to be " +
                "rejected on-chain. Use the lowercased checksum form your " +
                "wallet returns.",
            ),
          name: z
            .string()
            .optional()
            .describe(
              "First-call only. Free-form display name for the buyer agent, " +
                "max 64 chars, not validated for uniqueness. Defaults to " +
                "`buyer-<last6>` derived from your wallet. Appears on " +
                "receipts and in the Daski marketplace UI. Mutually " +
                "exclusive with `agentURI`.",
            ),
          agentURI: z
            .string()
            .optional()
            .describe(
              "First call (advanced) OR second call (required, echoed). " +
                "First call: optional ERC-8004 agentURI (https://, ipfs://, " +
                "or data: URI). Most buyers should pass `name` instead. " +
                "Second call: echo verbatim the agentURI returned by the " +
                "first call — it's baked into the typed-data the wallet " +
                "signed.",
            ),
          deadlineSeconds: z
            .number()
            .optional()
            .describe(
              "First-call only. Signature expiry, seconds from now. Default 3600.",
            ),
          deadline: z
            .string()
            .optional()
            .describe(
              "Second-call only. Echo verbatim the `deadline` returned by " +
                "the first call.",
            ),
          signature: z
            .string()
            .optional()
            .describe(
              "Second-call only. 0x-prefixed hex bytes from your wallet's " +
                "signTypedData over the first call's `eip712TypedData`.",
            ),
        },
        annotations: {
          // Mints an ERC-8004 agentId. The on-chain registry rejects a
          // second register-by-sig for the same wallet (already-registered
          // revert), so retrying with the same payload is a no-op.
          title: "Register a Daski agent",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      registerAgentHandler,
    );

    server.registerTool(
      "daski_prepare_registration",
      {
        description:
          "Deprecated alias. Call `daski_register_agent` without `signature` " +
          "to receive the RegisterAgent typed-data. Kept callable for one " +
          "release cycle.",
        inputSchema: {
          walletAddress: z.string(),
          name: z.string().optional(),
          agentURI: z.string().optional(),
          deadlineSeconds: z.number().optional(),
        },
        annotations: {
          title: "[Deprecated] Get RegisterAgent typed-data",
          readOnlyHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logDeprecatedToolCall("daski_prepare_registration");
        return registerAgentHandler({
          walletAddress: args.walletAddress,
          name: args.name,
          agentURI: args.agentURI,
          deadlineSeconds: args.deadlineSeconds,
        });
      },
    );

    server.registerTool(
      "daski_register_buyer",
      {
        description:
          "Deprecated alias. Call `daski_register_agent` with `signature` " +
          "(plus the `agentURI` and `deadline` returned by the first call) " +
          "to submit the registration. Kept callable for one release cycle.",
        inputSchema: {
          walletAddress: z.string(),
          agentURI: z.string(),
          deadline: z.string(),
          signature: z.string(),
        },
        annotations: {
          title: "[Deprecated] Register an ERC-8004 agent (gasless)",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        logDeprecatedToolCall("daski_register_buyer");
        return registerAgentHandler({
          walletAddress: args.walletAddress,
          agentURI: args.agentURI,
          deadline: args.deadline,
          signature: args.signature,
        });
      },
    );

    server.registerTool(
      "daski_prepare_confirm",
      {
        description:
          "Deprecated alias. Call `daski_confirm_delivery` without " +
          "`signature` to receive the same typed-data, then call it again " +
          "with the signed `{v,r,s}` to submit. Kept callable for one " +
          "release cycle.",
        inputSchema: {
          paymentId: z.string(),
          confirmation: z.enum(["Confirmed", "NotConfirmed"]),
          attester: z.string(),
          deadlineSeconds: z.number().optional(),
          refUid: z.string().optional(),
        },
        annotations: {
          title: "[Deprecated] Get EAS Attest typed-data for confirmation",
          readOnlyHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        logDeprecatedToolCall("daski_prepare_confirm");
        return confirmDeliveryHandler({
          paymentId: args.paymentId,
          confirmation: args.confirmation,
          attester: args.attester,
          deadlineSeconds: args.deadlineSeconds,
          refUid: args.refUid,
        });
      },
    );

    // Note: daski_prepare_dns_capability was removed in v4. The DNS
    // capability typed-data builder lives on the provider as a free A2A
    // skill `prepare-dns-capability`; agents reach it via daski_submit_task,
    // sign the returned typed-data, and pass the signed pair as the
    // `capability` arg on a subsequent set-dns-record submit_task.

    // ── A2A: submit_task / check_task ────────────────────────────────

    const SUBMIT_TASK_INPUT_SCHEMA = {
      providerA2AUrl: z.string(),
      skillId: z.string(),
      paymentId: z
        .string()
        .describe(
          'Decimal string returned by `daski_buy_service`. Pass `"0"` ' +
            "for free open skills (check-availability, get-pricing, " +
            "prepare-capability) — those skip the envelope-auth handshake.",
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
          "Required on the first call for paid / ownership-gated / " +
            "capability-gated skills — used to build the envelope-auth " +
            "typed-data the wallet signs. Optional on the second (signed) " +
            "call and on free open skills.",
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
            "will accept on the retry; this replaces the deprecated " +
            "`daski_build_envelope_auth` flow. On the retry, pass " +
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
    };

    type SubmitTaskArgs = {
      providerA2AUrl: string;
      skillId: string;
      paymentId: string;
      chainId: 8453 | 84532;
      buyerTokenId?: string;
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
    };

    const submitTaskHandler = async (
      args: SubmitTaskArgs,
    ): Promise<McpToolResult> => {
        // Envelope-auth is needed for every paid skill and every
        // ownership-/capability-gated free skill. The free open skills
        // (check-availability, get-pricing, prepare-capability) opt out by
        // passing `paymentId: "0"` or an empty paymentId — match the legacy
        // behavior so existing free-skill callers don't break.
        const requiresEnvelopeAuth =
          args.paymentId !== "0" && args.paymentId !== "";

        // First-call branch — return the typed-data the wallet must sign,
        // plus the matching messageId to thread back through. This absorbs
        // the legacy daski_build_envelope_auth flow.
        if (requiresEnvelopeAuth && !args.envelopeAuth) {
          if (!args.buyerTokenId) {
            return errorJson({
              code: "BAD_INPUT",
              message:
                "buyerTokenId is required on the first (no-envelopeAuth) " +
                "call for paid / ownership-gated / capability-gated skills. " +
                "Look it up via daski_search_services or pass the value " +
                "you already have.",
              recoverable: true,
              next_action:
                "Re-call this tool with buyerTokenId set; the response " +
                "will be the typed-data the wallet should sign.",
            });
          }
          const envelope = buildEnvelopeAuth({
            skillId: args.skillId,
            paymentId: args.paymentId,
            chainId: args.chainId,
            buyerTokenId: args.buyerTokenId,
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
              "call this tool again with envelopeAuth: { signature, " +
              "authorization } and the SAME messageId.",
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
        if (args.capability) meta.capability = args.capability;
        if (args.envelopeAuth) meta.envelopeAuth = args.envelopeAuth;

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

        // A2A v1.0 §5.3 mandates PascalCase method names. Pre-1.0
        // providers may still expect "message/send"; daski-provider
        // (and most other implementations during the transition)
        // dual-accepts.
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
          error?: { message?: string };
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
          return providerErrorFromFailure(post, args.providerA2AUrl, {
            contextId,
            nextAction:
              "Retry with the same contextId once the provider is reachable.",
          });
        }
        const rpc = post.body;
        if (rpc.error) {
          return errorJson({
            code: "PROVIDER_ERROR",
            message: rpc.error.message ?? "JSON-RPC error",
            details: { contextId },
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
          // Provider may send TASK_STATE_* (v1.0) or kebab (legacy).
          // MCP consumers expect kebab; normalize at the boundary.
          state: normalizeState(result.status?.state) ?? "submitted",
          providerA2AUrl: args.providerA2AUrl,
        };
        if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
          flattened.artifacts = result.artifacts;
        }
        if (result.status?.message) {
          flattened.statusMessage = result.status.message;
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
          "- Free read-only skills like `check-availability`, `get-pricing`, `prepare-capability` (pass `paymentId: \"0\"`, omit `envelopeAuth`).",
          "- After `daski_buy_service` settled a payment — dispatch the actual task using the returned `serviceRef` and `transactionHash`.",
          "- Continuing a multi-turn A2A conversation — pass the `contextId` from the previous turn.",
          "",
          "When NOT to use:",
          "- You are starting a paid purchase — use `daski_buy_service` first; it returns the `serviceRef` and `transactionHash` you'll need here.",
          "- You are polling an existing task — use `daski_get_task_status`.",
          "",
          "Inputs:",
          "- Free skill: `skillId`, `providerA2AUrl`, `chainId`, `paymentId: \"0\"`, `serviceArgs`.",
          "- Paid skill, first call (no signature): `skillId`, `providerA2AUrl`, `chainId`, `paymentId`, `serviceRef`, `transactionHash`, `buyerTokenId`, `serviceArgs`. Returns the envelope-auth typed-data to sign.",
          "- Paid skill, signed retry: the same inputs plus `envelopeAuth: { signature, authorization }` and the matching `messageId` from the first call.",
          "",
          "Returns:",
          "- First call on a paid skill: `{ eip712TypedData, authorization, messageId, hint }`. Sign `eip712TypedData` with the buyer's agent wallet, then call again with `envelopeAuth: { signature, authorization }` and the SAME `messageId`.",
          "- Free skill or second-call paid: `{ taskId, contextId, state, artifacts, statusMessage }`. `state` is one of `submitted | working | input-required | completed | failed`. `completed` and `failed` are terminal.",
          "",
          "Next step:",
          "- `state === 'completed'`: read `artifacts`, then optionally `daski_confirm_delivery`.",
          "- `state === 'working' | 'submitted'`: poll with `daski_get_task_status`.",
          "- `state === 'input-required'`: call this tool again with the additional info and the SAME `contextId`.",
          "- `state === 'failed'`: read `statusMessage`, optionally `daski_confirm_delivery` with `confirmation: 'NotConfirmed'`.",
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

    server.registerTool(
      "daski_build_envelope_auth",
      {
        description:
          "Deprecated alias. Call `daski_submit_task` without `envelopeAuth` " +
          "on a paid / ownership-gated / capability-gated skill — the " +
          "gateway returns the same typed-data, plus the matching " +
          "`messageId` for the signed retry. Kept callable for one release " +
          "cycle.",
        inputSchema: {
          skillId: z.string(),
          paymentId: z.string(),
          chainId: z.number(),
          buyerTokenId: z.string(),
          serviceArgs: z.record(z.string(), z.unknown()).optional(),
          messageId: z.string().optional(),
          issuedAt: z.number().optional(),
        },
        annotations: {
          title: "[Deprecated] Build envelope-auth typed-data",
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        logDeprecatedToolCall("daski_build_envelope_auth");
        const envelope = buildEnvelopeAuth({
          skillId: args.skillId,
          paymentId: args.paymentId,
          chainId: args.chainId,
          buyerTokenId: args.buyerTokenId,
          identityRegistryAddress: deps.config.identityRegistryAddress,
          serviceArgs: args.serviceArgs ?? {},
          messageId: args.messageId,
          issuedAt: args.issuedAt,
        });
        return json({
          messageId: envelope.messageId,
          requestHash: envelope.requestHash,
          issuedAt: envelope.issuedAt,
          authorization: envelope.authorization,
          eip712TypedData: envelope.eip712TypedData,
          hint:
            "Deprecated. Sign eip712TypedData with the buyer's agent " +
            "wallet, then call daski_submit_task with envelopeAuth + the " +
            "SAME messageId. The same handshake now happens automatically " +
            "if you call daski_submit_task without envelopeAuth on the " +
            "first attempt.",
        });
      },
    );

    // ── A2A task status (polling or SSE streaming) ───────────────────
    //
    // §3.7 — domain registrations regularly take 30-120s. Polling every
    // 2-5s wastes round trips on long tasks; the stream:true path opens
    // an SSE subscription against the provider's `SubscribeToTask` and
    // forwards each event as an MCP `notifications/progress`. The final
    // state (or the most recent state if streamingTimeoutMs elapses) is
    // returned as the tool result so callers that don't speak SSE can
    // still synchronize on completion. Falls back gracefully if the
    // provider doesn't implement streaming (`-32601` or non-SSE
    // content-type) — caller switches to stream:false to poll.
    server.registerTool(
      "daski_get_task_status",
      {
        description: [
          "Get the current state of a Daski provider task. Two modes: poll once, or stream live updates via SSE.",
          "",
          "When to use:",
          "- After `daski_submit_task` returned a non-terminal state (`submitted` or `working`).",
          "- The user asks \"is the domain registered yet?\" or similar.",
          "- You want live progress updates for a long-running task (set `stream: true`).",
          "",
          "When NOT to use:",
          "- You haven't dispatched a task yet — call `daski_submit_task` first.",
          "- The task is already `completed` or `failed` — those are terminal; just read the `artifacts` you already have.",
          "",
          "Inputs: `providerA2AUrl`, `taskId`; optional `stream` (default `false`); optional `streamingTimeoutMs` (default `120000`, i.e. 2 min).",
          "Returns: `{ state, artifacts, messages }`. `state` is one of `submitted | working | input-required | completed | failed`. `completed` and `failed` are terminal — stop polling.",
          "Next step:",
          "- `state === 'completed'`: optionally `daski_confirm_delivery`.",
          "- `state === 'working' | 'submitted'`: poll again after a short delay (5–10 seconds for fast skills, 30+ for slow ones).",
          "- `state === 'input-required'`: call `daski_submit_task` with the missing info and the same `contextId`.",
        ].join("\n"),
        inputSchema: {
          providerA2AUrl: z.string(),
          taskId: z.string(),
          stream: z
            .boolean()
            .optional()
            .describe(
              "If true, subscribe via SSE; if false (default), poll once.",
            ),
          streamingTimeoutMs: z
            .number()
            .optional()
            .describe(
              "Stream-mode only. Max ms to keep the SSE open. Default " +
                "120_000 (2 min). Tool returns the latest known state on " +
                "timeout — caller can resubscribe with the same taskId.",
            ),
        },
        annotations: {
          title: "Check a Daski task",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, extra) => {
        if (args.stream) {
          return streamTaskStatus(args, extra);
        }
        return pollTaskStatus(args);
      },
    );

    async function pollTaskStatus(args: {
      providerA2AUrl: string;
      taskId: string;
    }): Promise<McpToolResult> {
        // A2A v1.0: GetTask (was tasks/get). Provider dual-accepts.
        const body = {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "GetTask",
          params: { id: args.taskId },
        };
        type CheckRpc = {
          error?: { message?: string };
          result?: {
            id?: string;
            contextId?: string;
            status?: { state?: string; message?: { role?: string; parts?: any[] } };
            artifacts?: Array<{ name?: string; parts?: any[] }>;
          };
        };
        const post = await a2aPostJson<CheckRpc>(args.providerA2AUrl, body, {
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxBytes: A2A_RESPONSE_MAX_BYTES,
          failOnNonOk: true,
        });
        if (!post.ok) {
          return providerErrorFromFailure(post, args.providerA2AUrl);
        }
        const rpc = post.body;
        if (rpc.error) {
          return errorJson({
            code: "PROVIDER_ERROR",
            message: rpc.error.message ?? "JSON-RPC error",
          });
        }
        const result = rpc.result;
        if (!result) {
          return errorJson({
            code: "PROVIDER_ERROR",
            message: "Provider response missing result",
          });
        }
        // §2.1 — A2A v0.3.0 uses `kind` for part discriminator; older
        // providers (and our previous outbound shape) use `type`. Accept
        // either when parsing inbound provider responses.
        const partKind = (p: any): string | undefined => p?.kind ?? p?.type;
        const artifacts: Array<Record<string, unknown>> = [];
        for (const a of result.artifacts ?? []) {
          for (const p of a.parts ?? []) {
            const k = partKind(p);
            if (k === "file" && p.file?.url) {
              artifacts.push({
                type: "file",
                name: a.name ?? "(unnamed)",
                url: p.file.url,
                mimeType: p.file.mimeType,
              });
            } else if (k === "data" && p.data != null) {
              artifacts.push({
                type: "data",
                name: a.name ?? "(unnamed)",
                data: p.data,
              });
            }
          }
        }
        const messages: Array<Record<string, unknown>> = [];
        for (const p of result.status?.message?.parts ?? []) {
          if (partKind(p) === "text" && typeof p.text === "string") {
            messages.push({
              // Provider may send ROLE_USER/ROLE_AGENT (v1.0) or
              // user/agent (legacy). MCP consumers expect lowercase.
              role: normalizeRole(result.status?.message?.role) ?? "agent",
              content: p.text,
            });
          }
        }
        return json({
          taskId: typeof result.id === "string" ? result.id : args.taskId,
          contextId: result.contextId ?? null,
          status: normalizeState(result.status?.state) ?? "unknown",
          artifacts,
          messages,
        });
    }

    async function streamTaskStatus(
      args: {
        providerA2AUrl: string;
        taskId: string;
        streamingTimeoutMs?: number;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extra: any,
    ): Promise<McpToolResult> {
        const timeoutMs = args.streamingTimeoutMs ?? 120_000;
        const progressToken = extra._meta?.progressToken as
          | string
          | number
          | undefined;

        const guard = await guardProviderUrl(args.providerA2AUrl);
        if (guard) return guard;

        const controller = new AbortController();
        const overallTimer = setTimeout(() => controller.abort(), timeoutMs);

        // A2A v1.0: SubscribeToTask (was tasks/resubscribe). The
        // PascalCase/legacy method is selected at the JSON-RPC method
        // field; SSE response framing is unchanged.
        const body = {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "SubscribeToTask",
          params: { id: args.taskId },
        };

        let res: Response;
        try {
          res = await a2aFetch(args.providerA2AUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            redirect: "manual",
          });
        } catch (err) {
          clearTimeout(overallTimer);
          const e = err as { name?: string };
          return errorJson({
            code:
              e.name === "AbortError"
                ? "streaming_timeout"
                : "PROVIDER_UNREACHABLE",
            message: `Provider unreachable at ${args.providerA2AUrl}`,
            recoverable: true,
            next_action:
              "Retry daski_get_task_status (stream:true) or fall back to daski_get_task_status polling.",
          });
        }
        if (!res.ok) {
          clearTimeout(overallTimer);
          // -32601 method-not-found bubbles up as HTTP 200 with rpc.error;
          // here we hit the HTTP layer (404, 405) instead.
          return errorJson({
            code: "streaming_unsupported",
            message: `Provider returned HTTP ${res.status} on SubscribeToTask`,
            details: { status: res.status, providerA2AUrl: args.providerA2AUrl },
            recoverable: true,
            next_action:
              "Provider does not support SSE streaming. Use daski_get_task_status to poll instead.",
          });
        }

        // Some providers reject streaming with a JSON-RPC error in the
        // initial body. Detect that before treating the stream as SSE.
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.toLowerCase().includes("text/event-stream")) {
          clearTimeout(overallTimer);
          let rpc: { error?: { code?: number; message?: string } } = {};
          try {
            rpc = (await res.json()) as typeof rpc;
          } catch {
            // ignore — fall through to the generic message below
          }
          if (rpc.error?.code === -32601) {
            return errorJson({
              code: "streaming_unsupported",
              message:
                rpc.error.message ?? "Provider does not implement SubscribeToTask",
              recoverable: true,
              next_action: "Use daski_get_task_status to poll instead.",
            });
          }
          return errorJson({
            code: "streaming_unsupported",
            message:
              rpc.error?.message ?? `Provider returned non-SSE content-type: ${ct}`,
            recoverable: true,
            next_action: "Use daski_get_task_status to poll instead.",
          });
        }

        const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
        if (!reader) {
          clearTimeout(overallTimer);
          return errorJson({
            code: "streaming_unsupported",
            message: "Provider returned an empty SSE stream",
            recoverable: true,
            next_action: "Use daski_get_task_status to poll instead.",
          });
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let lastEvent: any = null;
        let progress = 0;
        // Bound the SSE stream so a malicious / hung provider can't tie up
        // the gateway's memory + CPU forever. The wall-clock `overallTimer`
        // (above) is the primary bound; these are belt-and-braces caps.
        let streamBytes = 0;

        const emit = async (event: any) => {
          progress += 1;
          const normalizedState = normalizeState(event?.status?.state);
          const stateMessage =
            normalizedState
              ? `state=${normalizedState}`
              : event?.kind
                ? `kind=${event.kind}`
                : "update";
          if (progressToken !== undefined) {
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress,
                  message: stateMessage,
                },
              });
            } catch {
              // The transport may be detached if the client disconnected;
              // ignore so we still drain the SSE stream cleanly.
            }
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              streamBytes += value.byteLength;
              if (streamBytes > SSE_TOTAL_MAX_BYTES) {
                return errorJson({
                  code: "PROVIDER_RESPONSE_TOO_LARGE",
                  message: `SSE stream exceeded ${SSE_TOTAL_MAX_BYTES} bytes`,
                  recoverable: true,
                  next_action: "Use daski_get_task_status to poll instead.",
                });
              }
            }
            buffer += decoder.decode(value, { stream: true });
            // Parse complete SSE events (separated by \n\n). Each event has
            // one or more `data:` lines that, joined, form a JSON-RPC
            // response. We extract the `result` payload.
            let sepIdx;
            while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
              const raw = buffer.slice(0, sepIdx);
              buffer = buffer.slice(sepIdx + 2);
              const dataLines = raw
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trimStart());
              if (dataLines.length === 0) continue;
              try {
                const parsed = JSON.parse(dataLines.join("\n")) as {
                  result?: any;
                  error?: { message?: string };
                };
                if (parsed.error) {
                  // Provider signaled an error mid-stream — surface it.
                  return errorJson({
                    code: "PROVIDER_ERROR",
                    message: parsed.error.message ?? "stream error",
                  });
                }
                if (parsed.result) {
                  lastEvent = parsed.result;
                  await emit(parsed.result);
                  if (progress > SSE_MAX_EVENTS) {
                    return errorJson({
                      code: "PROVIDER_TOO_MANY_EVENTS",
                      message: `SSE stream exceeded ${SSE_MAX_EVENTS} events`,
                      recoverable: true,
                      next_action: "Use daski_get_task_status to poll instead.",
                    });
                  }
                  // A2A signals stream end via final:true on the latest event.
                  if (parsed.result.final === true) {
                    return json({
                      taskId: args.taskId,
                      contextId: parsed.result.contextId ?? null,
                      state: normalizeState(parsed.result.status?.state) ?? "completed",
                      finalEvent: parsed.result,
                      eventCount: progress,
                    });
                  }
                }
              } catch {
                // Malformed event — skip; A2A allows server keepalives.
              }
            }
          }
        } catch (err) {
          const e = err as { name?: string };
          if (e.name !== "AbortError") {
            return errorJson({
              code: "PROVIDER_ERROR",
              message: `SSE read failed: ${(err as Error).message}`,
            });
          }
          // AbortError = our overallTimer fired → return latest known state.
        } finally {
          clearTimeout(overallTimer);
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
        }

        return json({
          taskId: args.taskId,
          contextId: lastEvent?.contextId ?? null,
          state: normalizeState(lastEvent?.status?.state) ?? "unknown",
          finalEvent: lastEvent,
          eventCount: progress,
          timedOut: true,
        });
    }

    // ── daski_buy_service path helpers ────────────────────────────────
    //
    // The orchestrator splits cleanly into three named paths:
    //   1. x402 retry — when paymentPayload arrives, run verify+settle+
    //      submit in one round-trip instead of returning a plan.
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
      walletAddress: string;
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
    }

    // Synchronous free skills (open-free, single round-trip, answer
    // inline). Driven off `skillMeta.directEndpoint`; older provider
    // deployments that haven't migrated still dispatch `check-availability`
    // to /availability via the legacy fallback so the audit refactor
    // doesn't force a coordinated provider deploy.
    function resolveSynchronousDispatch(
      skillMeta: Record<string, unknown>,
      skillId: string,
    ): { endpoint: string; kind: string } | null {
      const direct = skillMeta["directEndpoint"];
      if (typeof direct === "string" && direct.startsWith("/")) {
        const kind =
          typeof skillMeta["directResultKind"] === "string"
            ? (skillMeta["directResultKind"] as string)
            : "direct";
        return { endpoint: direct, kind };
      }
      if (skillId === "check-availability") {
        return { endpoint: "/availability", kind: "availability" };
      }
      return null;
    }

    function resolveBuyServiceProvider(
      args: BuyServiceArgs,
    ):
      | { ok: true; provider: ProviderMatch }
      | { ok: false; error: McpToolResult } {
      const matches = findProvidersOfferingSkill(deps.cache, args.skillId);
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
      const serviceRefRaw =
        reqs?.extra?.daski?.serviceRef ??
        (inboundPayload as { serviceRef?: string }).serviceRef;
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
      const needsRegistration = challenge.buyerTokenId === 0n;
      if (needsRegistration && !args.registration) {
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

      const settleResult = needsRegistration
        ? await verifyAndSettleWithRegistration(
            { payload: inboundPayload, challenge },
            {
              agentURI: args.registration!.agentURI,
              deadline: BigInt(args.registration!.deadline),
              signature: args.registration!.signature as Hex,
            },
            deps.config,
            deps.reader,
            deps.queries,
            new Date(),
            { fetchAgentCardFn: deps.buyerAgentCardFetch },
          )
        : await verifyAndSettle(
            { payload: inboundPayload, challenge },
            deps.config,
            deps.reader,
            deps.queries,
          );

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

      // Same A2A envelope shape as daski_submit_task.
      const a2aMeta: Record<string, unknown> = {
        skillId: challenge.skillId,
        paymentId: settlement.daski?.paymentId,
        chainId: deps.config.chainId,
        serviceRef: serviceRefRaw,
        transactionHash: settlement.transaction,
      };
      const a2aParts: Array<Record<string, unknown>> = [
        { kind: "text", text: `Execute skill ${challenge.skillId}` },
      ];
      const submitArgs = normalizeContactFields(args.serviceArgs ?? {});
      if (Object.keys(submitArgs).length > 0) {
        a2aParts.push({ kind: "data", data: submitArgs });
      }
      const messageId = randomUUID();
      const contextId = randomUUID();
      const a2aBody = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            parts: a2aParts,
            messageId,
            contextId,
            metadata: { [DASKI_A2A_EXTENSION_URI]: a2aMeta },
          },
        },
      };

      type SubmitJsonAfterSettle = {
        error?: { message?: string };
        result?: {
          id?: string;
          contextId?: string;
          status?: { state?: string; message?: unknown };
          artifacts?: unknown[];
        };
      };
      const post = await a2aPostJson<SubmitJsonAfterSettle>(
        challenge.providerA2AUrl,
        a2aBody,
        {
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxBytes: A2A_RESPONSE_MAX_BYTES,
        },
      );
      // The settle already landed on-chain — any post-settle failure
      // must echo enough context (paymentId/serviceRef/txHash) that the
      // caller can retry with daski_submit_task without re-paying.
      if (!post.ok) {
        return errorJson(
          {
            code: "submit_failed_after_settle",
            message:
              post.reason === "timeout" || post.reason === "unreachable"
                ? `Settled on-chain but A2A submit_task failed: ${post.message}. ` +
                  "Use daski_submit_task with the returned paymentId/serviceRef to retry."
                : post.reason === "non_json"
                  ? `provider returned non-JSON after settle (status ${post.status})`
                  : `provider returned HTTP ${post.status ?? "?"} after settle`,
            details: {
              paymentId: settlement.daski?.paymentId,
              serviceRef: serviceRefRaw,
              transactionHash: settlement.transaction,
              providerA2AUrl: challenge.providerA2AUrl,
            },
            recoverable: true,
            next_action:
              "Call daski_submit_task explicitly with the paymentId/serviceRef from details.",
          },
          responseMeta,
        );
      }
      const submitJson = post.body;
      if (!post.raw.ok || submitJson.error) {
        return errorJson(
          {
            code: "submit_failed_after_settle",
            message:
              submitJson.error?.message ??
              `provider returned HTTP ${post.status} after settle`,
            details: {
              paymentId: settlement.daski?.paymentId,
              serviceRef: serviceRefRaw,
              transactionHash: settlement.transaction,
              providerA2AUrl: challenge.providerA2AUrl,
            },
            recoverable: true,
            next_action:
              "Call daski_submit_task explicitly to dispatch the task.",
          },
          responseMeta,
        );
      }
      const taskResult = submitJson.result;
      return json(
        {
          success: true,
          kind: "paid-resource",
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
          taskId: taskResult?.id ?? null,
          contextId: taskResult?.contextId ?? contextId,
          state: normalizeState(taskResult?.status?.state) ?? "submitted",
          artifacts: taskResult?.artifacts ?? [],
          statusMessage: taskResult?.status?.message ?? null,
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
        // Map the helper's reason codes to the legacy direct-dispatch
        // error envelope (lowercase `provider_*`) so on-chain free
        // skills keep their existing agent-facing surface.
        if (post.reason === "timeout") {
          return errorJson({
            code: "provider_timeout",
            message: `${ctx.args.skillId} at ${targetUrl} failed: ${post.message}`,
          });
        }
        if (post.reason === "unreachable") {
          return errorJson({
            code: "provider_unreachable",
            message: `${ctx.args.skillId} at ${targetUrl} failed: ${post.message}`,
          });
        }
        if (post.reason === "non_json") {
          return errorJson({
            code: "provider_error",
            message: `${ctx.args.skillId} returned non-JSON (status ${post.status})`,
          });
        }
        return providerErrorFromFailure(post, targetUrl);
      }
      const body = post.body;
      if (!post.raw.ok) {
        return errorJson({
          code:
            (body.error as { code?: string } | undefined)?.code ??
            "provider_error",
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
        capabilityType: string | null;
      },
    ): McpToolResult {
      const { args, provider, providerA2AUrl, serviceArgs } = ctx;
      const { isOpenFree, requiresCapability, requiresAssetOwnership, capabilityType } = flags;
      const steps: Array<{ toolName: string; hint: string; args: unknown }> = [];
      // Capability-gated skills need an upstream prepare-capability hop.
      // The misconfig guard in `runBuyServiceFreePath` ensures
      // capabilityType is non-null whenever requiresCapability is true.
      if (requiresCapability && capabilityType) {
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "Fetch the EIP-712 typed-data for this capability as a free " +
            "A2A skill on the provider. Sign the returned eip712TypedData " +
            "with your wallet; extract the signature.",
          args: {
            providerA2AUrl,
            skillId: "prepare-capability",
            paymentId: args.paymentId,
            chainId: deps.config.chainId,
            serviceArgs: {
              capabilityType,
              paymentId: args.paymentId,
              buyerTokenId: args.buyerTokenId,
              // Echo the entire serviceArgs so the schema-specific
              // builder pulls the fields it commits to (e.g. domain,
              // recordType, recordName for set-dns; domain, recordId
              // for delete-dns).
              ...serviceArgs,
            },
          },
        });
      }
      // Envelope auth: required for any non-open-free skill. We collapse
      // build+submit into a single daski_submit_task two-call exchange:
      // - First call (no envelopeAuth) → returns typed-data + messageId.
      // - Sign the typed-data with the buyer wallet.
      // - Second call (with envelopeAuth + matching messageId) → dispatch.
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
      if (!isOpenFree) {
        steps.push({
          toolName: "daski_submit_task",
          hint:
            "Second call: pass envelopeAuth: { signature, authorization } and " +
            "the SAME messageId returned by the first call. The gateway " +
            "forwards the task to the provider over A2A." +
            (requiresCapability
              ? " Also pass the signed { signature, authorization } as `capability`."
              : ""),
          args: {
            providerA2AUrl,
            skillId: args.skillId,
            ...(args.paymentId ? { paymentId: args.paymentId } : {}),
            chainId: deps.config.chainId,
            serviceArgs,
            messageId: "<from first daski_submit_task call>",
            envelopeAuth: "<signed envelope from sign step>",
            ...(requiresCapability
              ? { capability: "<signed capability from previous step>" }
              : {}),
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
      const capabilityType =
        typeof provider.skillMeta.capabilityType === "string"
          ? (provider.skillMeta.capabilityType as string)
          : null;

      // Provider-misconfiguration guard: a capability-gated skill that
      // doesn't declare its capabilityType can't have a usable plan
      // emitted — the prepare-capability step needs the type, and the
      // submit step would instruct the caller to pass a `capability`
      // that no upstream step provides. Surface the misconfig instead
      // of silently returning a half-baked plan.
      if (requiresCapability && !capabilityType) {
        return errorJson({
          code: "provider_missing_capability_type",
          message:
            `Provider ${provider.agentId} advertises requiresCapability=true ` +
            `for skill '${args.skillId}' but does not declare 'capabilityType' ` +
            "in skill metadata. The gateway can't build a usable plan.",
          details: {
            providerTokenId: provider.agentId.toString(),
            skillId: args.skillId,
          },
          next_action:
            "Ask the provider to add 'capabilityType' to the skill's daski " +
            "metadata, or use a different provider.",
        });
      }

      // Synchronous direct-dispatch (open-free + declared
      // `directEndpoint`, or the legacy `check-availability` fallback).
      // The provider's response fields land inline; no plan steps.
      if (isOpenFree) {
        const sync = resolveSynchronousDispatch(
          provider.skillMeta,
          args.skillId,
        );
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
        capabilityType,
      });
    }

    async function runBuyServicePaidPath(
      ctx: BuyServiceCtx,
    ): Promise<McpToolResult> {
      const { args, provider, providerA2AUrl, serviceArgs, buyerAgentId } = ctx;

      // Live-quote the provider before issuing paymentRequirements so
      // the buyer pays the actual price AND user-input errors (bad
      // phone, unsupported TLD, missing fields) surface before any
      // USDC moves. The A2A URL convention is `<base>/a2a[/<slug>]`;
      // /quote mirrors that shape, so we swap the segment in place.
      const quoteUrl = providerA2AUrl.replace(/\/a2a(?=\/|$)/, "/quote");

      // Track whether the amount came from THIS request's live /quote.
      // Caller-supplied args.amount is NOT trusted as a quote — that
      // would bypass resolveAmount's static floor check (audit P1).
      let quoteAmount: string | undefined = args.amount;
      let quoteNotes: string[] = [];
      let quoteAmountFromLiveQuote = false;
      if (!args.amount) {
        type QuoteJson = {
          ok?: boolean;
          amount?: string;
          currency?: string;
          notes?: string[];
          errors?: Array<{ field: string; code: string; message: string }>;
        };
        const post = await a2aPostJson<QuoteJson>(
          quoteUrl,
          { skillId: args.skillId, serviceArgs },
          {
            fetch: a2aFetch,
            timeoutMs: a2aTimeoutMs,
            maxBytes: A2A_RESPONSE_MAX_BYTES,
          },
        );
        if (!post.ok) {
          if (post.reason === "timeout") {
            return errorJson({
              code: "provider_timeout",
              message: `quote at ${quoteUrl} failed: ${post.message}`,
            });
          }
          if (post.reason === "unreachable") {
            return errorJson({
              code: "provider_unreachable",
              message: `quote at ${quoteUrl} failed: ${post.message}`,
            });
          }
          if (post.reason === "non_json") {
            return errorJson({
              code: "quote_malformed",
              message: `provider /quote returned non-JSON (status ${post.status})`,
            });
          }
          return providerErrorFromFailure(post, quoteUrl);
        }
        const quoteJson = post.body;
        if (!quoteJson.ok) {
          return errorJson({
            code: "quote_validation_failed",
            message:
              "Provider rejected the requested args. Fix the listed errors and retry.",
            details: { validationErrors: quoteJson.errors ?? [] },
            recoverable: true,
            next_action:
              "Fix the listed validationErrors in serviceArgs and retry daski_buy_service.",
          });
        }
        if (!quoteJson.amount) {
          return errorJson({
            code: "quote_malformed",
            message: "provider /quote returned ok=true with no amount",
          });
        }
        quoteAmount = quoteJson.amount;
        quoteNotes = quoteJson.notes ?? [];
        quoteAmountFromLiveQuote = true;
      }

      const resource = `${deps.config.publicUrl}/purchase/${provider.agentId.toString()}`;
      const result = await issuePaymentRequirements(
        {
          providerTokenId: provider.agentId,
          buyerTokenId: buyerAgentId,
          skillId: args.skillId,
          amount: quoteAmount,
          resource,
          walletAddress: args.walletAddress.toLowerCase() as Hex,
          trustQuotedAmount: quoteAmountFromLiveQuote,
        },
        deps.config,
        deps.cache,
        deps.queries,
      );
      if (!result.ok) {
        return errorJson({ code: result.code, message: result.message });
      }
      const r = result.requirements;

      // Fresh wallets get a RegisterAgent prep block alongside the
      // payment so the agent can sign both typed-data blocks back to
      // back, then submit them atomically via daski_settle_payment.
      const isAtomic = buyerAgentId === 0n;
      let registrationPrep: unknown = null;
      if (isAtomic) {
        try {
          const nonce = await deps.reader.getRegistrationNonce(
            args.walletAddress.toLowerCase() as Hex,
          );
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          const deadline = nowSec + 3600n;
          // ERC-8004 §2.2 conformance: default to a non-empty data: URI
          // resolving to a minimal buyer card so reputation queries and
          // Bazaar / agentic.market indexers can fetch agent metadata.
          const agentURI = defaultBuyerAgentURI(
            args.walletAddress.toLowerCase() as Hex,
          );
          registrationPrep = {
            walletAddress: args.walletAddress.toLowerCase(),
            agentURI,
            nonce: nonce.toString(),
            deadline: deadline.toString(),
            eip712TypedData: {
              domain: {
                name: "Daski IdentityRegistry",
                version: "1",
                chainId: deps.config.chainId,
                verifyingContract: deps.config.identityRegistryAddress,
              },
              types: {
                RegisterAgent: [
                  { name: "agentURI", type: "string" },
                  { name: "agentWallet", type: "address" },
                  { name: "nonce", type: "uint256" },
                  { name: "deadline", type: "uint256" },
                ],
              },
              primaryType: "RegisterAgent",
              message: {
                agentURI,
                agentWallet: args.walletAddress.toLowerCase(),
                nonce: nonce.toString(),
                deadline: deadline.toString(),
              },
            },
            submitTemplate: {
              walletAddress: args.walletAddress.toLowerCase(),
              agentURI,
              deadline: deadline.toString(),
            },
          };
        } catch (err) {
          return errorJson({
            code: "CHAIN_READ_FAILED",
            message: `registrationNonce reverted: ${(err as Error).message}`,
          });
        }
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
            "pass to daski_settle_payment alongside the payment payload.",
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
          providerA2AUrl: result.challenge.providerA2AUrl,
          skillId: args.skillId,
          serviceRef: result.challenge.serviceRef,
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
          providerA2AUrl: result.challenge.providerA2AUrl,
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
      return json(
        {
          kind: "paid",
          atomic: isAtomic,
          providerTokenId: provider.agentId.toString(),
          providerA2AUrl: result.challenge.providerA2AUrl,
          skillId: args.skillId,
          serviceArgs,
          chainId: deps.config.chainId,
          network: deps.config.network,
          acceptedToken: {
            address: deps.config.usdcAddress,
            name: deps.config.usdcName,
            version: deps.config.usdcVersion,
            chainId: deps.config.chainId,
            network: deps.config.network,
          },
          quoteNotes,
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
          "**Start here for any paid Daski service.** Orchestrates the full purchase: validates inputs, prepares the USDC payment, settles on-chain after wallet signing, and dispatches the task to the provider — in two round-trips end-to-end.",
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
          "- First call (no signature): `providerTokenId`, `skillId`, `serviceArgs` (per the skill's `requiredFields`), `walletAddress`.",
          "- Second call (signed retry): the same inputs plus `paymentPayload`, `paymentRequirements`, and (for fresh wallets) `registration`.",
          "",
          "Returns:",
          "- First call: `paymentRequirements` (contains `extra.daski.eip712TypedData` to sign) plus an optional `registrationPrep` block (sign this too on first-ever purchase from a fresh wallet) and a `plan[]` outlining the remaining tool calls.",
          "- Second call: `{ paymentId, transactionHash, serviceRef, providerA2AUrl, buyerTokenId, settled: true }`. The task is NOT dispatched yet (unless the second call also produced a successful A2A submit).",
          "",
          "Next step: `daski_submit_task` with the returned `serviceRef`, `transactionHash`, and `paymentId`.",
          "",
          "Fresh-wallet note: a wallet with no ERC-8004 agentId auto-registers on first purchase via a second signature, bundled into the same on-chain tx as the USDC payment. Watch for `registrationPrep` in the first response and sign both typed-data blocks before retrying.",
        ].join("\n"),
        inputSchema: {
          skillId: z.string(),
          walletAddress: z
            .string()
            .describe(
              "The exact address the wallet will sign with. Baked into " +
                "the typed-data — mismatch causes the signed payload to be " +
                "rejected on-chain. Use the lowercased checksum form your " +
                "wallet returns.",
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
                "skills[].requiredFields. Contact fields (firstName, " +
                "lastName, email, …) accept either flat keys or a nested " +
                "object under `registrant`/`admin`/`tech`/`billing` — the " +
                "gateway normalizes both shapes.",
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
          // When set, the gateway runs verify+settle and dispatches the
          // task in one tool call instead of returning a plan. Equivalent
          // to chaining daski_settle_payment + daski_submit_task. Also
          // accepted via request _meta["x402/payment"] (base64) for
          // x402-mcp interop.
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
                "Triggers atomic verify+settle+submit. Required when retrying " +
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
                "same wallet, then pass v/r/s here.",
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
        // _meta["x402/payment"]), verify+settle+submit runs in one
        // round-trip. The helper returns null on the read-only first
        // leg so we fall through to plan-building.
        const retry = await runBuyServiceX402Retry(args, extra);
        if (retry !== null) return retry;

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

        // Resolve buyerAgentId. A non-zero caller-supplied value wins;
        // missing OR an explicit "0" both fall through to the on-chain
        // lookup. Treating "0" as a valid override would route an
        // already-registered wallet down atomic register-and-settle and
        // burn the buyer's USDC re-minting an agentId they already have
        // (or surface as a bare "execution reverted" when registerBySig
        // sees a stale nonce). agentOfWallet is the single source of
        // truth — let it speak.
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
              message: `agentOfWallet reverted: ${(err as Error).message}`,
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
        const providerA2AUrl = extractAgentCardUrl(cached.agentCard);
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
        };

        const paymentRequired =
          provider.skillMeta.paymentRequired !== false;
        return paymentRequired
          ? runBuyServicePaidPath(ctx)
          : runBuyServiceFreePath(ctx);
      },
    );
  }

  // ── Resources ────────────────────────────────────────────────────────
  //
  // §5 — agents that already know a providerTokenId (from search_services)
  // can read the full Agent Card via a Resource URI instead of a tool
  // call. The shape is identical to one entry of search_services, served
  // lazily so it doesn't enter the tool budget.

  function registerResources(server: McpServer) {
    server.registerResource(
      "daski-provider",
      new ResourceTemplate("daski://provider/{tokenId}", {
        list: async () => ({
          resources: deps.cache.getAll().map((p) => ({
            uri: `daski://provider/${p.agentId.toString()}`,
            name:
              (p.agentCard as { name?: string }).name ?? `provider#${p.agentId}`,
            description: `Daski provider agent card (tokenId ${p.agentId.toString()}).`,
            mimeType: "application/json",
          })),
        }),
      }),
      {
        title: "Daski provider",
        description:
          "Full agent card + skill metadata for a single Daski provider, " +
          "addressed by ERC-8004 agentId. Same shape as one entry of " +
          "search_services. Read this when the agent already has a " +
          "tokenId in hand and just needs the details.",
      },
      async (uri, variables) => {
        const tokenId = String(variables.tokenId);
        let id: bigint;
        try {
          id = BigInt(tokenId);
        } catch {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "tokenId must be a numeric string",
                }),
              },
            ],
          };
        }
        const provider = deps.cache.get(id);
        if (!provider) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({
                  error: "provider is not whitelisted or not in cache",
                }),
              },
            ],
          };
        }
        const formatted = formatForSkillDiscover([provider])[0];
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      },
    );
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  function buildSession(flag: DeprecationFlag): Promise<Session> {
    const server = new McpServer(
      { name: "daski-gateway", version: "0.2.0" },
      {
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          // §5 — provider details are exposed as MCP Resources
          // (`daski://provider/{tokenId}`) so MCP-aware UIs (Claude Code
          // `@`-mention, Cursor) can lazy-load full Agent Cards without
          // costing a tool slot. The legacy `daski_get_provider` tool
          // remains callable during the deprecation grace period and is
          // surfaced in `tools/list` only when the client opts in via
          // `?include=deprecated` or `X-Daski-Include-Deprecated`.
          resources: { listChanged: false },
        },
        // Planted in the `initialize` response so the model sees the
        // canonical workflow before any individual tool description.
        instructions: SERVER_INSTRUCTIONS,
      },
    );
    registerTools(server);
    registerResources(server);

    // Override the McpServer's auto-generated `tools/list` handler so
    // deprecated aliases are hidden by default. Deprecated tools stay
    // *callable* — the override only touches the listing.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools = listRegisteredTools(server);
      const visible = flag.includeDeprecated
        ? allTools
        : allTools.filter((t) => !DEPRECATED_TOOL_NAMES.has(t.name));
      return { tools: visible };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    return server.connect(transport).then(() => ({ server, transport }));
  }

  app.post(deps.config.mcpPath, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const includeDeprecated = requestWantsDeprecated(req);
        const fresh = await buildSession({ includeDeprecated });
        await fresh.transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Unknown MCP session" },
        id: null,
      });
    } catch (err) {
      console.error("[mcp POST]", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get(deps.config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!existing) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Unknown MCP session" },
        id: null,
      });
      return;
    }
    try {
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp GET]", err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  app.delete(deps.config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!existing) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "Unknown MCP session" },
        id: null,
      });
      return;
    }
    try {
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp DELETE]", err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  return {
    sessionCount() {
      return sessions.size;
    },
    async close() {
      for (const session of sessions.values()) {
        try {
          await session.transport.close();
        } catch {
          /* ignore */
        }
        try {
          await session.server.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
    },
  };
}

// ── Provider matching helpers (kept local so MCP doesn't import buyService) ──

interface ProviderMatch {
  agentId: bigint;
  skillMeta: Record<string, unknown>;
}

function findProvidersOfferingSkill(
  cache: DiscoveryCache,
  skillId: string,
): ProviderMatch[] {
  const matches: ProviderMatch[] = [];
  for (const p of cache.getAll()) {
    const meta = findSkillMeta(p, skillId);
    if (meta === null) continue;
    matches.push({ agentId: p.agentId, skillMeta: meta });
  }
  return matches;
}

function findSkillMeta(
  provider: CachedProvider,
  skillId: string,
): Record<string, unknown> | null {
  const skills = provider.agentCard["skills"];
  let listed = false;
  if (Array.isArray(skills)) {
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      if ((skill as Record<string, unknown>)["id"] !== skillId) continue;
      listed = true;
      const meta = (skill as Record<string, unknown>)["metadata"];
      if (meta && typeof meta === "object") {
        const daskiMeta = (meta as Record<string, unknown>)[DASKI_A2A_EXTENSION_URI];
        if (daskiMeta && typeof daskiMeta === "object") {
          return daskiMeta as Record<string, unknown>;
        }
      }
      break;
    }
  }
  const ext = extractMarketplaceExtension(provider.agentCard) as
    | (Record<string, unknown> & { skills?: unknown })
    | null;
  const skillMap = ext?.skills;
  if (skillMap && typeof skillMap === "object" && !Array.isArray(skillMap)) {
    const meta = (skillMap as Record<string, unknown>)[skillId];
    if (meta && typeof meta === "object") {
      return meta as Record<string, unknown>;
    }
  }
  return listed ? {} : null;
}
