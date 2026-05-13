import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Express } from "express";
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

    server.registerTool(
      "search_services",
      {
        description:
          "Find Daski providers and skills matching the agent's intent. " +
          "Pass a free-text `intent` (e.g. 'register a .com domain') and " +
          "the gateway returns the most relevant providers ranked by " +
          "vector similarity over pgvector embeddings of every skill in " +
          "the catalog. Each match includes the provider's full " +
          "AgentCard-shaped descriptor (agentCardUrl, a2aUrl, skills with " +
          "requiredFields and pricing) so the agent can call the provider " +
          "via A2A directly or via daski_submit_task. Without `intent`, " +
          "returns the unranked catalog (use `category` / `maxPrice` to " +
          "narrow). Replaces the legacy daski_discover tool.",
        inputSchema: {
          intent: z
            .string()
            .optional()
            .describe(
              "Free-text description of what the agent wants to do. " +
                "Embedded with pgvector; ranked by cosine similarity over " +
                "every (provider, skill) pair in the catalog.",
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
        },
        annotations: {
          title: "Search Daski services",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
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
      },
    );

    server.registerTool(
      "daski_get_provider",
      {
        description:
          "Fetch a single provider by ERC-8004 agentId. Returns the same " +
          "shape as one entry of search_services. Kept as a back-compat " +
          "alias; new agents should use search_services or the " +
          "`daski://provider/{tokenId}` MCP Resource.",
        inputSchema: {
          providerTokenId: z.string(),
        },
        annotations: {
          title: "Get Daski provider by tokenId",
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
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
        description:
          "Open a payment challenge. Returns x402 PaymentRequirements with " +
          "an inline EIP-712 typed-data block (extra.daski.eip712TypedData). " +
          "Pass that block to your wallet's generic signTypedData tool — no " +
          "schema knowledge required. Then assemble a paymentPayload " +
          "{ x402Version: 1, scheme, network, payload: { signature, " +
          "authorization: <message> } } and call daski_settle_payment.",
        inputSchema: {
          providerTokenId: z.string(),
          buyerTokenId: z.string().describe("Buyer's ERC-8004 agentId."),
          walletAddress: z
            .string()
            .describe(
              "The wallet address that will sign. Baked into the typed-data " +
                "`from` field; the wallet MUST sign with this exact address.",
            ),
          skillId: z.string().optional(),
          amount: z
            .string()
            .optional()
            .describe("Atomic USDC units. Defaults to skill base."),
        },
        annotations: {
          title: "Open x402 payment challenge",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
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
        description:
          "Submit a signed paymentPayload on-chain via the gateway's " +
          "facilitator wallet. Takes the x402 paymentPayload (signature + " +
          "authorization) and the original paymentRequirements that " +
          "produced the typed-data block. Returns paymentId, transaction " +
          "hash, and providerA2AUrl — everything daski_submit_task needs. " +
          "If the buyer wallet was unregistered when the challenge was " +
          "issued (paymentRequirements.extra.daski.buyerTokenId === '0'), " +
          "ALSO pass `registration` with a signed RegisterAgent payload " +
          "from daski_prepare_registration. Both will be submitted in one " +
          "atomic tx (the USDC payment is the Sybil tax for the new agentId).",
        inputSchema: {
          paymentPayload: z
            .object({
              x402Version: z.number(),
              scheme: z.string(),
              network: z.string(),
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
            .optional()
            .describe(
              "Required only when paymentRequirements.extra.daski.buyerTokenId " +
                "=== '0' (atomic register-and-settle for fresh wallets). " +
                "Get the typed-data from daski_prepare_registration and " +
                "sign with the same wallet that signed the payment.",
            ),
        },
        annotations: {
          // Settlement is destructive (moves USDC on-chain) but idempotent:
          // EIP-3009 nonces are consumed on first use, so a retry of the
          // same payload reverts on-chain. Daski returns the cached
          // settlement instead of re-submitting.
          title: "Settle x402 payment + (optional) register",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
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
              "RegisterAgent payload — see daski_prepare_registration.",
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

    server.registerTool(
      "daski_confirm_delivery",
      {
        description:
          "Submit a signed buyer-confirmation EAS attestation. Use " +
          "daski_prepare_confirm to fetch the typed-data, sign it with " +
          "your wallet, then pass v/r/s here. Gateway relays the delegated " +
          "attestation on-chain (buyer pays no gas).",
        inputSchema: {
          paymentId: z.string(),
          confirmation: z.enum(["Confirmed", "NotConfirmed"]),
          attester: z.string(),
          deadline: z.string(),
          refUid: z.string().optional(),
          signature: z.object({
            v: z.number(),
            r: z.string(),
            s: z.string(),
          }),
        },
        annotations: {
          // Submits an EAS attestation on-chain (gateway pays gas, buyer
          // signs). Not idempotent: the EAS resolver rejects a duplicate
          // confirmation for the same paymentId, so a retry will revert.
          title: "Submit buyer-confirmation EAS attestation",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
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
      },
    );

    // ── Prepare typed-data (wallet-agnostic signing helpers) ─────────

    server.registerTool(
      "daski_prepare_registration",
      {
        description:
          "Returns the EIP-712 RegisterAgent typed-data your wallet signs " +
          "to enroll a fresh wallet as an ERC-8004 agent. Gateway relays " +
          "the signed bytes via the facilitator wallet so the buyer pays " +
          "no gas. Use when the buyer has no agentId yet (most fresh " +
          "wallets). For a one-shot first purchase, prefer daski_buy_service " +
          "(or pass the resulting `registration` to daski_settle_payment) — " +
          "that bundles registration + payment into one atomic on-chain tx. " +
          "Optionally pass `name` to set the buyer's display name on " +
          "receipts and in the marketplace UI.",
        inputSchema: {
          walletAddress: z.string(),
          name: z
            .string()
            .optional()
            .describe(
              "Optional display name for your buyer agent. Free-form, max " +
                "64 characters, not validated for uniqueness. Defaults to " +
                "`buyer-<last6>` derived from your wallet. Appears on " +
                "receipts and in the Daski marketplace UI. Mutually " +
                "exclusive with `agentURI`.",
            ),
          agentURI: z
            .string()
            .optional()
            .describe(
              "Advanced. Optional ERC-8004 agentURI (an https:// URL, " +
                "ipfs:// CID, or data: URI resolving to the agent's " +
                "registration JSON). When provided, the gateway fetches " +
                "it and reads `name` from the JSON. Mutually exclusive " +
                "with the `name` parameter. Most buyers should pass " +
                "`name` instead.",
            ),
          deadlineSeconds: z
            .number()
            .optional()
            .describe("Signature expiry, seconds from now. Default 3600."),
        },
        annotations: {
          title: "Get RegisterAgent typed-data",
          readOnlyHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!HEX_ADDR.test(args.walletAddress)) {
          return errorJson({
            code: "BAD_WALLET",
            message: "walletAddress must be a 20-byte hex address",
          });
        }
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
      },
    );

    server.registerTool(
      "daski_register_buyer",
      {
        description:
          "Submit a signed RegisterAgent payload via the gateway facilitator. " +
          "Mints an ERC-8004 agentId to walletAddress and caches the " +
          "buyer's display name (read from the signed agentURI's JSON) " +
          "for use on receipts and in the marketplace UI. Use this when " +
          "you want to register WITHOUT an immediate purchase (e.g. to " +
          "read your reputation first). For a first-purchase flow, prefer " +
          "the atomic register-and-settle path through daski_buy_service " +
          "/ daski_settle_payment, which bundles both into one tx so the " +
          "USDC payment carries the Sybil tax for the registration.",
        inputSchema: {
          walletAddress: z.string(),
          agentURI: z
            .string()
            .describe(
              "The exact agentURI the wallet signed at " +
                "daski_prepare_registration. Whether built from the " +
                "buyer-supplied `name` or from a hosted JSON, the gateway " +
                "treats this as the source of truth and reads the display " +
                "name from it.",
            ),
          deadline: z.string().describe("Unix seconds; same value used in the typed-data."),
          signature: z.string().describe("0x-prefixed hex bytes from your wallet's signTypedData."),
        },
        annotations: {
          // Mints an ERC-8004 agentId. The on-chain registry rejects a
          // second register-by-sig for the same wallet (already-registered
          // revert), so retrying with the same payload is a no-op.
          title: "Register an ERC-8004 agent (gasless)",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
        if (!HEX_ADDR.test(args.walletAddress)) {
          return errorJson({
            code: "BAD_WALLET",
            message: "walletAddress must be a 20-byte hex address",
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
      },
    );

    server.registerTool(
      "daski_prepare_confirm",
      {
        description:
          "Returns the EIP-712 Attest typed-data to sign for a buyer " +
          "confirmation. Reads the EAS attester nonce from chain so the " +
          "agent doesn't need an RPC of its own. Pass the typed-data block " +
          "to your wallet's signTypedData; extract {v,r,s}; call " +
          "daski_confirm_delivery.",
        inputSchema: {
          paymentId: z.string(),
          confirmation: z.enum(["Confirmed", "NotConfirmed"]),
          attester: z.string(),
          deadlineSeconds: z.number().optional(),
          refUid: z.string().optional(),
        },
        annotations: {
          title: "Get EAS Attest typed-data for confirmation",
          readOnlyHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => {
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
      },
    );

    // Note: daski_prepare_dns_capability was removed in v4. The DNS
    // capability typed-data builder lives on the provider as a free A2A
    // skill `prepare-dns-capability`; agents reach it via daski_submit_task,
    // sign the returned typed-data, and pass the signed pair as the
    // `capability` arg on a subsequent set-dns-record submit_task.

    // ── A2A: submit_task / check_task ────────────────────────────────

    server.registerTool(
      "daski_submit_task",
      {
        description:
          "Dispatch the actual service task to the provider over A2A after " +
          "payment has settled (paid) or capability has been signed (free " +
          "capability-gated). For paid skills include serviceRef and " +
          "transactionHash from daski_settle_payment. For capability-gated " +
          "free skills, include the `capability` returned by the provider's " +
          "`prepare-capability` skill (reach it via this same tool with " +
          "skillId='prepare-capability' and capabilityType set, sign the " +
          "returned typed-data, then reuse the original asset's paymentId). " +
          "Paid and ownership-/capability-gated skills also require " +
          "`envelopeAuth` — an EIP-712 A2ARequestAuthorization signed by " +
          "the buyer's agent wallet that binds (skillId, paymentId, " +
          "messageId, requestHash, …). Build it with daski_build_envelope_auth, " +
          "sign the typed-data, then pass { signature, authorization } and " +
          "the matching `messageId`. Open free skills (check-availability, " +
          "get-pricing, prepare-capability) skip envelopeAuth. " +
          "Returns { taskId, contextId, state, ... } — thread contextId back " +
          "into daski_get_task_status (poll or stream) / daski_confirm_delivery " +
          "to keep the multi-turn A2A conversation linked.",
        inputSchema: {
          providerA2AUrl: z.string(),
          skillId: z.string(),
          paymentId: z.string(),
          chainId: z.number(),
          serviceRef: z.string().optional(),
          transactionHash: z.string().optional(),
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
              "A2A messageId. REQUIRED whenever envelopeAuth is set — the " +
                "envelope signature binds to this exact value, and the " +
                "provider rejects mismatches. Auto-generated only when no " +
                "envelopeAuth is provided.",
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
              "Signed A2ARequestAuthorization. Build the typed-data with " +
                "daski_build_envelope_auth, sign with the buyer's agent " +
                "wallet, then pass { signature, authorization } here.",
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
        },
        annotations: {
          title: "Submit task over A2A",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
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
              "messageId returned by daski_build_envelope_auth.",
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
      },
    );

    // ── A2A envelope auth: build the typed-data for the buyer to sign ─
    //
    // Every paid / ownership-gated / capability-gated A2A call must carry
    // a signed A2ARequestAuthorization in metadata.envelopeAuth. The
    // buyer's agent wallet signs an EIP-712 typed-data committing to
    // (buyerTokenId, skillId, paymentId, chainId, messageId, requestHash,
    // issuedAt). This tool is the pure-compute helper that produces the
    // typed-data: pass the about-to-be-sent request, sign the returned
    // eip712TypedData with the wallet, then thread { signature, authorization }
    // + the same messageId into daski_submit_task.
    server.registerTool(
      "daski_build_envelope_auth",
      {
        description:
          "Build the EIP-712 typed-data the buyer's agent wallet signs to " +
          "produce envelopeAuth for daski_submit_task. Pure compute; no " +
          "chain calls, no DB writes. Generates a fresh messageId and " +
          "issuedAt, hashes the canonical-JSON serviceArgs into requestHash, " +
          "and wraps everything in the Daski auth domain. Sign the returned " +
          "eip712TypedData with the buyer wallet, then call daski_submit_task " +
          "with messageId from this result and envelopeAuth = " +
          "{ signature, authorization: <returned authorization> }. " +
          "Required for paid, ownership-gated, and capability-gated skills.",
        inputSchema: {
          skillId: z.string(),
          paymentId: z
            .string()
            .describe("Decimal string. Pass \"0\" if the skill isn't bound to a payment."),
          chainId: z.number(),
          buyerTokenId: z.string().describe("Decimal string. The signer's ERC-8004 agentId."),
          serviceArgs: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "The exact serviceArgs you'll submit to daski_submit_task. " +
                "Mutating any field after signing invalidates the envelope.",
            ),
          messageId: z
            .string()
            .optional()
            .describe("Optional override. Auto-generated if omitted."),
          issuedAt: z
            .number()
            .optional()
            .describe("Optional override (seconds since epoch). Defaults to now."),
        },
        annotations: {
          title: "Build envelope-auth typed-data",
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async (args) => {
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
            "Sign eip712TypedData with the buyer's agent wallet. Pass the " +
            "signature + authorization back via daski_submit_task's " +
            "envelopeAuth arg, and use the SAME messageId here.",
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
        description:
          "Get the current state of a provider A2A task. Default mode " +
          "(stream:false) polls via GetTask and returns flattened " +
          "{ state, artifacts, messages }. Streaming mode (stream:true) " +
          "subscribes via SubscribeToTask SSE and forwards each event as " +
          "an MCP `notifications/progress`; returns the final task state " +
          "when the stream closes or streamingTimeoutMs elapses. Use " +
          "stream:true for long-running paid skills (domain registration, " +
          "etc.); use stream:false for quick polls or when the provider " +
          "doesn't support streaming. Pass a `progressToken` via request " +
          "_meta to receive intermediate stream events.",
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
          title: "Get A2A task status",
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
      // Envelope auth: required for any non-open-free skill.
      if (!isOpenFree) {
        steps.push({
          toolName: "daski_build_envelope_auth",
          hint:
            "Build the A2ARequestAuthorization typed-data. Sign the " +
            "returned eip712TypedData with the buyer's agent wallet. " +
            "Retain the messageId returned here — daski_submit_task " +
            "rejects if it doesn't match what you signed.",
          args: {
            skillId: args.skillId,
            paymentId: args.paymentId ?? "0",
            chainId: deps.config.chainId,
            buyerTokenId: args.buyerTokenId,
            serviceArgs,
          },
        });
      }
      steps.push({
        toolName: "daski_submit_task",
        hint: isOpenFree
          ? "Dispatch directly. No paymentId, serviceRef, or " +
            "transactionHash, and no envelopeAuth. Open-free skills " +
            "complete synchronously: the result (artifacts + " +
            "statusMessage) is returned inline in this call's response " +
            "— DO NOT call daski_get_task_status, the taskId is " +
            "non-persistent."
          : "Dispatch the task to the provider. OMIT serviceRef and " +
            "transactionHash. Pass envelopeAuth + the same messageId " +
            "from daski_build_envelope_auth." +
            (requiresCapability
              ? " Also pass the signed { signature, authorization } as `capability`."
              : ""),
        args: {
          providerA2AUrl,
          skillId: args.skillId,
          ...(args.paymentId ? { paymentId: args.paymentId } : {}),
          chainId: deps.config.chainId,
          serviceArgs,
          ...(isOpenFree
            ? {}
            : {
                messageId: "<from daski_build_envelope_auth>",
                envelopeAuth: "<signed envelope from previous step>",
              }),
          ...(requiresCapability
            ? { capability: "<signed capability from previous step>" }
            : {}),
        },
      });
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
              "daski_prepare_registration + daski_register_buyer " +
              "first, then retry.",
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
      steps.push({
        toolName: "daski_prepare_confirm",
        hint:
          "After daski_get_task_status reports state='completed' (or " +
          "'failed'), call this to fetch the EAS Attest typed-data. " +
          "Use confirmation:'Confirmed' for a positive review, " +
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
          "Sign daski_prepare_confirm's eip712TypedData with the SAME " +
          "wallet that paid (the EAS attestation must come from that " +
          "address). Extract { v, r, s } from the signature.",
        args: { typedData: "<from daski_prepare_confirm.eip712TypedData>" },
      });
      steps.push({
        toolName: "daski_confirm_delivery",
        hint:
          "Submit the v/r/s. Gateway facilitator relays the delegated " +
          "EAS attestation; buyer pays no gas. Bumps the provider's " +
          "confirmed/notConfirmed counter on ReputationStorage.",
        args: {
          paymentId: "<from daski_settle_payment>",
          confirmation: "Confirmed",
          attester: args.walletAddress.toLowerCase(),
          deadline: "<from daski_prepare_confirm.deadline>",
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
        description:
          "High-level orchestrator. For paid skills: discovers the provider " +
          "(if not specified), validates serviceArgs against requiredFields, " +
          "and returns paymentRequirements with inline EIP-712 typed-data. " +
          "After signing with your wallet, call daski_settle_payment then " +
          "daski_submit_task. For free ownership-gated skills, returns a " +
          "plan that points at the provider's `prepare-dns-capability` " +
          "free A2A skill (via daski_submit_task) + a second daski_submit_task. " +
          "Validates required fields up front. " +
          "If the wallet has no ERC-8004 agentId yet (fresh CDP wallet, " +
          "no Daski identity), the orchestrator returns an atomic " +
          "register-and-settle plan: registrationPrep is included, the " +
          "wallet signs both typed-data blocks, and daski_settle_payment " +
          "submits both in one tx so the USDC payment is the Sybil tax " +
          "for the new agentId.",
        inputSchema: {
          skillId: z.string(),
          walletAddress: z.string(),
          buyerTokenId: z
            .string()
            .optional()
            .describe(
              "Buyer's ERC-8004 agentId. Optional — if omitted the gateway " +
                "looks it up via the wallet, and routes to atomic " +
                "register-and-settle for fresh wallets.",
            ),
          providerTokenId: z.string().optional(),
          serviceArgs: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Skill-specific arguments. Per-skill required fields are " +
                "advertised in search_services under skills[].requiredFields. " +
                "Contact fields (firstName, lastName, email, …) accept either " +
                "flat keys or a nested object under `registrant`/`admin`/" +
                "`tech`/`billing` — the gateway normalizes both shapes.",
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
              x402Version: z.number(),
              scheme: z.string(),
              network: z.string(),
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
          title: "Buy a Daski service (orchestrator)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
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

  function buildSession(): Promise<Session> {
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
          // stays as a back-compat alias.
          resources: { listChanged: false },
        },
      },
    );
    registerTools(server);
    registerResources(server);
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
        const fresh = await buildSession();
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
