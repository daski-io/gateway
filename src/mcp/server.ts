import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Express } from "express";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import { safeFetch } from "../util/urlSafety.js";
import type { McpToolResult } from "./util.js";
import { registerArtifactTool } from "./artifact.js";
import { MCP_LEGAL_INSTRUCTIONS } from "../legal/purchase.js";
import {
  mountMcpHttpTransport,
  type McpWiring,
} from "./httpTransport.js";
import { GATEWAY_VERSION } from "../version.js";
import { registerProviderResource } from "./providerResource.js";
import { instrumentToolCalls } from "./instrumentation.js";
import { sessionMetrics } from "./sessionMetrics.js";
import { registerDiscoveryTool } from "./discoveryTool.js";
import { registerConfirmDeliveryTool } from "./confirmDeliveryTool.js";
import { registerAgentTool } from "./registerAgentTool.js";
import { registerTaskStatusTool } from "./taskStatusTool.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import { registerSubmitTaskTool } from "./submitTaskTool.js";
import { registerBuyServiceTool } from "./buyServiceTool.js";
import { runBuyService } from "./buyServiceWorkflow.js";
import { runSubmitTask } from "./submitTaskWorkflow.js";
import { ConcurrencyLimiter } from "./concurrencyLimiter.js";
import { UNTRUSTED_PROVIDER_CONTENT_WARNING } from "./providerReflection.js";
import type { ChainDeploymentReadinessProbe } from "../payment/deploymentReadiness.js";
import type { DaskiFacilitatorService } from "../payment/daskiFacilitator.js";

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
  deploymentReadiness: ChainDeploymentReadinessProbe;
  facilitator: DaskiFacilitatorService;
  reputationWorker: ReputationMirrorWorker;
  pool: import("../db/pool.js").Pool;
  embeddingSync?: import("../discovery/embeddingSync.js").CatalogEmbeddingSynchronizer | null;
  embedder?: import("../discovery/embeddings.js").Embedder | null;
  fetch?: typeof fetch;
  /** Test seam. Unset in production: the deadlines come from
   *  `config.a2aTimeoutMs` / `config.a2aSubmitTimeoutMs`. */
  a2aTimeoutMs?: number;
  /**
   * Test seam for the buyer-side agentURI fetcher used by the atomic
   * register-and-settle path inside daski_buy_service. Defaults to the
   * production safeFetch; the test
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

// Server-level instructions — planted in the MCP `initialize` response and
// surfaced by Anthropic clients before any individual tool description. The
// canonical workflow lives here so the model has the map before it sees the
// individual tool surface.
function serverInstructions(config: Config): string {
  const networkInstructions =
    config.chainId === 84532
      ? [
          "This gateway uses Base Sepolia testnet (chainId 84532). Faucet USDC:",
          "https://faucet.circle.com/.",
        ]
      : ["This gateway uses Base mainnet (chainId 8453). Payments use real USDC."];
  return [
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
    "daski_buy_service is the only payment entry point; x402 retries return to it.",
    "",
    UNTRUSTED_PROVIDER_CONTENT_WARNING,
    "",
    ...networkInstructions,
  ].join("\n");
}

export async function createMcpServer(
  app: Express,
  deps: McpDeps,
): Promise<McpWiring> {
  // Per-session telemetry rollups flush on idle (mcp.session_metrics log
  // lines) — the production-side replacement for the retired judge loop.
  sessionMetrics.start();
  // Default to safeFetch (validates host + pins resolved IP at connect).
  // Tests inject deps.fetch with a mock that ignores SSRF; the loose
  // signature means a `(url, init) => Promise<Response>` mock satisfies
  // safeFetch's `(url, init?, preValidated?)` signature without changes.
  const a2aFetch: (
    u: string,
    i?: RequestInit,
  ) => Promise<Response> = deps.fetch ?? safeFetch;
  const enforceUrlSafety = deps.fetch === undefined;
  // Config-driven (GATEWAY_A2A_TIMEOUT_MS / GATEWAY_A2A_SUBMIT_TIMEOUT_MS);
  // `deps.a2aTimeoutMs` stays the test seam and, when set, overrides both so
  // a test forcing a timeout still forces it on submit.
  const a2aTimeoutMs = deps.a2aTimeoutMs ?? deps.config.a2aTimeoutMs;
  const a2aSubmitTimeoutMs = deps.a2aTimeoutMs ?? deps.config.a2aSubmitTimeoutMs;
  const artifactLimiter = new ConcurrencyLimiter(8, 1);
  const streamLimiter = new ConcurrencyLimiter(20, 2);
  function registerTools(server: McpServer) {
    registerArtifactTool(
      server,
      deps.cache,
      {
        fetch: a2aFetch,
        timeoutMs: a2aTimeoutMs,
      },
      artifactLimiter,
    );
    registerDiscoveryTool(server, deps);

    registerConfirmDeliveryTool(server, deps);
    registerAgentTool(server, deps);

    const submitTaskHandler = async (
      args: SubmitTaskArgs,
    ): Promise<McpToolResult> => {
      return runSubmitTask(args, deps, {
        fetch: a2aFetch,
        timeoutMs: a2aSubmitTimeoutMs,
        maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
      });
    };

    registerSubmitTaskTool(server, submitTaskHandler);

    registerTaskStatusTool(server, deps, {
      fetch: a2aFetch,
      timeoutMs: a2aTimeoutMs,
      enforceUrlSafety,
      maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
      streamLimiter,
    });

    registerBuyServiceTool(
      server,
      async (args, extra) => {
        return runBuyService(args, extra, deps, {
          fetch: a2aFetch,
          timeoutMs: a2aTimeoutMs,
          maxResponseBytes: A2A_RESPONSE_MAX_BYTES,
        });
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
        instructions: serverInstructions(deps.config),
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
