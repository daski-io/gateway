import express, { type Express } from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { ChainReader } from "./chain/reader.js";
import { DiscoveryCache } from "./discovery/cache.js";
import { createDiscoveryRouter } from "./discovery/routes.js";
import { createPurchaseRouter } from "./payment/routes.js";
import { createConfirmRouter } from "./payment/confirm.js";
import { createFacilitatorRouter } from "./payment/facilitator.js";
import { createPrepRouter } from "./payment/prep.js";
import { createIdentityRouter } from "./identity/routes.js";
import { createMcpServer, type McpWiring } from "./mcp/server.js";
import { createPublicRouter } from "./public/routes.js";
import { createQueries, type Queries } from "./db/queries.js";
import { createPool, runMigrations, type Pool } from "./db/pool.js";
import { xenovaEmbedder, type Embedder } from "./discovery/embeddings.js";
import type { FetchFn } from "./discovery/cache.js";
import type { FetchAgentCardOptions } from "./identity/fetch-agent-card.js";
import { rateLimit, securityHeaders } from "./util/security.js";

export interface CreateAppOptions {
  config: Config;
  reader: ChainReader;
  pool?: Pool;
  /**
   * Embedder for `search_services`. Default: Xenova all-MiniLM-L6-v2,
   * lazy-loaded on first search. Tests inject a deterministic stub.
   * Pass `null` to disable embedding sync entirely (search_services
   * intent queries will then fall back to no-op).
   */
  embedder?: Embedder | null;
  agentCardFetch?: FetchFn;
  a2aFetch?: typeof fetch;
  a2aTimeoutMs?: number;
  startCacheRefreshLoop?: boolean;
  agentCardFetchTimeoutMs?: number;
  /**
   * Test seam for the buyer agentURI fetcher used at /register-prep and
   * /register. Production leaves this undefined so the global `fetch`
   * is used; tests pass a stub that maps test URIs to known JSON without
   * going to the network.
   */
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
}

export interface AppBundle {
  app: Express;
  cache: DiscoveryCache;
  pool: Pool;
  queries: Queries;
  embedder: Embedder | null;
  mcp: McpWiring | null;
  expireInterval: NodeJS.Timeout | null;
  shutdown(): Promise<void>;
}

export async function createApp(options: CreateAppOptions): Promise<AppBundle> {
  const { config, reader } = options;
  const pool =
    options.pool ?? createPool({ connectionString: config.databaseUrl });
  const ownsPool = options.pool === undefined;
  await runMigrations(pool);
  const queries = createQueries(pool);
  const embedder: Embedder | null =
    options.embedder === null
      ? null
      : (options.embedder ?? xenovaEmbedder());

  const cache = new DiscoveryCache({
    reader,
    whitelist: config.whitelistedAgentIds,
    refreshIntervalSeconds: config.cacheRefreshIntervalSeconds,
    fetch: options.agentCardFetch,
    agentCardFetchTimeoutMs: options.agentCardFetchTimeoutMs,
    // Embeddings are synced lazily inside search_services (when intent
    // is provided) so the call deterministically sees fresh data. The
    // sync is cheap when the catalog is unchanged (one indexed scan
    // over skill_embeddings; no embeddings recomputed).
    onCatalogChanged: undefined,
    logger: console,
  });

  const app = express();
  // Trust the immediate proxy (Railway / single-LB / Cloudflare). Without
  // this, `req.ip` resolves to the proxy's address and the per-IP rate
  // limiter collapses into a global bucket. Operators behind a multi-hop
  // proxy chain can override via TRUST_PROXY=N. `0` disables (direct
  // exposure / local dev).
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
  app.use(securityHeaders);
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "1mb" }));

  // ── Rate limits on facilitator-funded / state-changing routes ─────
  //
  // Each of these endpoints either submits a tx that the facilitator
  // pays gas for, or hits the chain on the operator's behalf. Without a
  // limiter, a single hostile client can spam invalid signatures to
  // drain operator gas (gateway-audit P1: registration + confirm gas
  // burn). Tunable per-IP cap; reasonable burst tolerance for legit
  // multi-step flows. Skipped under NODE_ENV=test so the test suite
  // doesn't get throttled when it issues many calls in a tight loop.
  if (process.env.NODE_ENV !== "test") {
    const stateChangeLimiter = rateLimit({ windowMs: 60_000, max: 30 });
    app.use(
      [
        "/purchase",
        "/verify",
        "/settle",
        "/confirm",
        "/register",
        "/register-prep",
      ],
      stateChangeLimiter,
    );
    // POSTs to the MCP transport dispatch tool calls that can submit txs,
    // hit RPC, and write to Postgres. Without this limiter, an anonymous
    // client could bypass the REST gates entirely by going through /mcp.
    // Sized higher than the REST limit because a normal MCP session does
    // 5–10 tool calls per buy flow. SSE responses (GET /mcp) and session
    // teardown (DELETE /mcp) are not limited so reconnects don't consume
    // budget.
    const mcpLimiter = rateLimit({ windowMs: 60_000, max: 60 });
    app.post(config.mcpPath, mcpLimiter);
  }

  // Request logging — JSON-structured to match provider format
  app.use((req, res, next) => {
    const start = Date.now();
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        message: "HTTP request received",
        method: req.method,
        path: req.path,
      }),
    );
    res.on("finish", () => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "HTTP request completed",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration: Date.now() - start,
        }),
      );
    });
    next();
  });

  // SKILL.md is the wallet-agnostic choreography prompt for agents that
  // load skills from a URL (Cowork plugin, manual `~/.claude/skills/`
  // drop-ins, etc.). Served as text/markdown so plugin loaders that fetch
  // by URL get a clean parse.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // After tsc build, src/ becomes dist/, but the static/ directory is
  // copied alongside. Look in both locations to be robust.
  const skillCandidates = [
    path.resolve(__dirname, "./static/SKILL.md"),
    path.resolve(__dirname, "../src/static/SKILL.md"),
    path.resolve(__dirname, "../../src/static/SKILL.md"),
  ];
  const skillPath = skillCandidates.find((p) => fs.existsSync(p));
  app.get(["/skill.md", "/SKILL.md", "/.well-known/skill.md"], (_req, res) => {
    if (!skillPath) {
      res.status(500).type("text/plain").send("SKILL.md not bundled");
      return;
    }
    res.type("text/markdown").sendFile(skillPath);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      chain: {
        chainId: config.chainId,
        network: config.network,
      },
      cache: {
        providers: cache.getAll().length,
        lastRefresh: cache.getLastRefresh()?.toISOString() ?? null,
      },
    });
  });

  // ── Discoverability (§3.10) ────────────────────────────────────────────
  //
  // Three indexer / crawler-friendly surfaces:
  //   • /.well-known/mcp.json — MCP transport descriptor for clients that
  //     auto-discover hosted servers (Cowork plugin loaders, mcp-registry).
  //   • /.well-known/x402-services.json — list of paid resources in the
  //     spec-shaped accepts[] form, so x402scan / Bazaar / MPP indexers can
  //     surface Daski providers without Daski-specific knowledge.
  //   • /llms.txt + /llms-full.txt — markdown summaries for LLM crawlers
  //     (Quicknode/Pinata convention).

  app.get("/.well-known/mcp.json", (_req, res) => {
    res.json({
      name: "daski-gateway",
      version: "0.2.0",
      description:
        "Daski marketplace gateway — discover providers, settle x402 " +
        "payments in USDC on Base, and dispatch A2A tasks. " +
        "Wallet-agnostic: signing happens in the agent's wallet, not here.",
      transport: {
        type: "streamable-http",
        url: `${config.publicUrl}${config.mcpPath}`,
      },
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      docs: `${config.publicUrl}/skill.md`,
      chain: {
        chainId: config.chainId,
        network: config.network,
      },
    });
  });

  app.get("/.well-known/x402-services.json", (_req, res) => {
    const services = cache.getAll().flatMap((p) => {
      const skills = Array.isArray((p.agentCard as { skills?: unknown }).skills)
        ? ((p.agentCard as { skills: Array<Record<string, unknown>> }).skills)
        : [];
      const card = p.agentCard as { url?: string; name?: string };
      return skills.flatMap((s) => {
        const meta = (s.metadata as Record<string, unknown> | undefined)?.[
          "https://daski.xyz/a2a/v1"
        ] as Record<string, unknown> | undefined;
        if (!meta || meta.paymentRequired === false) return [];
        const baseAmount = meta.baseAmount;
        if (typeof baseAmount !== "string") return [];
        return [
          {
            resource: `${config.publicUrl}/purchase/${p.agentId.toString()}`,
            scheme: "exact",
            network: config.network,
            asset: config.usdcAddress,
            payTo: config.paymentRouterAddress,
            maxAmountRequired: baseAmount,
            description: `${card.name ?? "provider"} — ${s.id}`,
            providerTokenId: p.agentId.toString(),
            skillId: s.id,
            providerA2AUrl: card.url ?? null,
          },
        ];
      });
    });
    res.json({
      x402Version: 1,
      services,
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/llms.txt", (_req, res) => {
    res
      .type("text/markdown")
      .send(
        [
          "# Daski Gateway",
          "",
          "Daski is a decentralized marketplace where agents pay providers in",
          "USDC for real-world services (domain registration, DNS, etc.) over",
          "A2A. Settlement on Base via x402; identity + reputation on ERC-8004.",
          "",
          `- MCP endpoint: ${config.publicUrl}${config.mcpPath}`,
          `- x402 services: ${config.publicUrl}/.well-known/x402-services.json`,
          `- A2A discovery: ${config.publicUrl}/discover`,
          `- Skill prompt: ${config.publicUrl}/skill.md`,
          `- Full docs: ${config.publicUrl}/llms-full.txt`,
          `- Network: ${config.network} (chainId ${config.chainId})`,
          "",
        ].join("\n"),
      );
  });

  app.get("/llms-full.txt", (_req, res) => {
    const providers = cache
      .getAll()
      .map(
        (p) =>
          `- agentId ${p.agentId.toString()}: ${
            (p.agentCard as { name?: string }).name ?? "(unnamed)"
          }`,
      )
      .join("\n");
    res
      .type("text/markdown")
      .send(
        [
          "# Daski Gateway — full surface",
          "",
          "## Tools (MCP)",
          "",
          "- search_services — intent-driven search over the provider catalog",
          "- daski_get_provider — fetch a single provider by agentId",
          "- (check-availability is reached via daski_submit_task on the provider's free A2A skill)",
          "- daski_buy_service — orchestrator (returns plan; accepts paymentPayload for x402 retry)",
          "- daski_purchase — open a payment challenge",
          "- daski_settle_payment — settle a signed x402 payload (+ optional registration)",
          "- daski_submit_task — dispatch task over A2A (parts:[text,data], messageId, contextId)",
          "- daski_get_task_status — poll (stream:false) or SSE-stream (stream:true) a provider's A2A task",
          "- daski_prepare_registration / daski_register_buyer — gasless ERC-8004 registration",
          "- daski_prepare_confirm / daski_confirm_delivery — buyer-confirmation EAS attestation",
          "- (prepare-dns-capability is reached via daski_submit_task on the provider's free A2A skill)",
          "",
          "## HTTP surface",
          "",
          "- POST /purchase/:tokenId — x402 paywalled (HTTP 402 challenge → X-PAYMENT retry)",
          "- POST /verify, /settle — x402 facilitator endpoints",
          "- GET /supported — facilitator advertisement",
          "- POST /confirm/:paymentId — submit signed buyer confirmation",
          "- GET /register-prep, POST /register — gasless registration",
          "- GET /discover — provider catalog",
          "- GET /public/v1/* — read-only public API",
          "",
          "## Providers (live)",
          "",
          providers || "(none in cache)",
          "",
        ].join("\n"),
      );
  });

  app.use(createDiscoveryRouter(cache, config));
  app.use(createPurchaseRouter({ config, cache, queries, reader }));
  app.use(createConfirmRouter({ config, reader, queries }));
  app.use(
    createFacilitatorRouter({
      config,
      queries,
      reader,
      fetchAgentCardFn: options.buyerAgentCardFetch,
    }),
  );
  app.use(createPrepRouter({ config, reader }));
  app.use(
    createIdentityRouter({
      config,
      reader,
      queries,
      fetchAgentCardFn: options.buyerAgentCardFetch,
    }),
  );
  app.use(createPublicRouter({ config, cache, queries, reader }));

  let mcp: McpWiring | null = null;
  if (config.mcpEnabled) {
    mcp = await createMcpServer(app, {
      config,
      cache,
      queries,
      reader,
      pool,
      embedder,
      fetch: options.a2aFetch,
      a2aTimeoutMs: options.a2aTimeoutMs,
      buyerAgentCardFetch: options.buyerAgentCardFetch,
    });
  }

  // Expire stale challenges every 5 minutes
  let expireInterval: NodeJS.Timeout | null = null;
  if (options.startCacheRefreshLoop !== false) {
    expireInterval = setInterval(() => {
      void queries.expireStaleChallenges().catch((err) => {
        console.error("expireStaleChallenges failed:", err);
      });
    }, 5 * 60 * 1000);
    cache.start();
  }

  async function shutdown() {
    if (expireInterval) clearInterval(expireInterval);
    cache.stop();
    if (mcp) {
      try {
        await mcp.close();
      } catch {
        /* ignore */
      }
    }
    if (ownsPool) {
      try {
        await pool.end();
      } catch {
        // ignore
      }
    }
  }

  return {
    app,
    cache,
    pool,
    queries,
    embedder,
    mcp,
    expireInterval,
    shutdown,
  };
}
