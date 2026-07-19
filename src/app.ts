import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors from "cors";
import type { Config } from "./config.js";
import type { ChainReader } from "./chain/reader.js";
import { DiscoveryCache, type FetchFn } from "./discovery/cache.js";
import { createDiscoveryRouter } from "./discovery/routes.js";
import { createPurchaseRouter } from "./payment/routes.js";
import { createConfirmRouter } from "./payment/confirm.js";
import { createFacilitatorRouter } from "./payment/facilitator.js";
import { createBazaarRouter } from "./payment/bazaar.js";
import { createExternalFacilitatorClient } from "./payment/externalFacilitator.js";
import { createPrepRouter } from "./payment/prep.js";
import { createIdentityRouter } from "./identity/routes.js";
import { createMcpServer, type McpWiring } from "./mcp/server.js";
import { createPublicRouter } from "./public/routes.js";
import { createQueries, type Queries } from "./db/queries.js";
import { createPool, runMigrations, type Pool } from "./db/pool.js";
import { xenovaEmbedder, type Embedder } from "./discovery/embeddings.js";
import type { FetchAgentCardOptions } from "./identity/fetch-agent-card.js";
import { rateLimit, securityHeaders } from "./util/security.js";
import { safeFetch } from "./util/urlSafety.js";
import { logErrorWithId } from "./util/errorWrap.js";
import { createMetaRouter } from "./http/metaRoutes.js";
import { logger } from "./util/logger.js";

export interface CreateAppOptions {
  config: Config;
  reader: ChainReader;
  pool?: Pool;
  embedder?: Embedder | null;
  agentCardFetch?: FetchFn;
  a2aFetch?: typeof fetch;
  a2aTimeoutMs?: number;
  startCacheRefreshLoop?: boolean;
  agentCardFetchTimeoutMs?: number;
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
  externalFacilitatorFetch?: typeof fetch;
  mcpMaxSessions?: number;
  mcpMaxSessionsPerClient?: number;
  mcpSessionIdleTtlMs?: number;
  mcpSessionSweepIntervalMs?: number;
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

function configureMiddleware(
  app: Express,
  queries: Queries,
  config: Config,
): void {
  const trustProxy = Number(process.env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer");
  }
  app.set("trust proxy", trustProxy);
  app.use(securityHeaders);
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "1mb" }));

  if (process.env.NODE_ENV === "test") return;
  app.use(
    [
      "/purchase",
      "/verify",
      "/settle",
      "/confirm",
      "/register",
      "/register-prep",
      "/x402",
    ],
    rateLimit({
      windowMs: 60_000,
      max: 30,
      namespace: "state-change",
      store: queries,
    }),
  );
  app.post(
    config.mcpPath,
    rateLimit({
      windowMs: 60_000,
      max: 60,
      namespace: "mcp",
      store: queries,
    }),
  );
}

export async function createApp(options: CreateAppOptions): Promise<AppBundle> {
  const { config, reader } = options;
  const pool =
    options.pool ?? createPool({ connectionString: config.databaseUrl });
  const ownsPool = options.pool === undefined;
  await runMigrations(pool);
  const queries = createQueries(pool);
  const embedder =
    options.embedder === null
      ? null
      : (options.embedder ?? xenovaEmbedder());
  const cache = new DiscoveryCache({
    reader,
    whitelist: config.whitelistedAgentIds,
    refreshIntervalSeconds: config.cacheRefreshIntervalSeconds,
    maxCardStalenessSeconds: config.cacheMaxStalenessSeconds,
    fetch: options.agentCardFetch,
    agentCardFetchTimeoutMs: options.agentCardFetchTimeoutMs,
    logger,
  });
  void embedder?.warmup?.().catch((error) => {
    logErrorWithId("embedder.warmup", error);
  });

  const app = express();
  configureMiddleware(app, queries, config);
  app.use(createMetaRouter({ config, cache, embedder }));
  app.use(createDiscoveryRouter(cache, config));
  app.use(createPurchaseRouter({ config, cache, queries, reader }));

  if (config.directAdapterAddress) {
    app.use(
      createBazaarRouter({
        config,
        cache,
        queries,
        reader,
        facilitator: createExternalFacilitatorClient({
          baseUrl: config.externalFacilitatorUrl,
          authHeader: config.externalFacilitatorAuthHeader,
          fetchFn: options.externalFacilitatorFetch,
        }),
        quoteFetch: options.a2aFetch ?? safeFetch,
        quoteTimeoutMs: options.a2aTimeoutMs,
      }),
    );
  }
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
  app.use(
    createPublicRouter({
      config,
      cache,
      queries,
      reader,
      buyerAgentCardFetch: options.buyerAgentCardFetch,
    }),
  );

  const mcp = config.mcpEnabled
    ? await createMcpServer(app, {
        config,
        cache,
        queries,
        reader,
        pool,
        embedder,
        fetch: options.a2aFetch,
        a2aTimeoutMs: options.a2aTimeoutMs,
        buyerAgentCardFetch: options.buyerAgentCardFetch,
        maxSessions: options.mcpMaxSessions,
        maxSessionsPerClient: options.mcpMaxSessionsPerClient,
        sessionIdleTtlMs: options.mcpSessionIdleTtlMs,
        sessionSweepIntervalMs: options.mcpSessionSweepIntervalMs,
      })
    : null;
  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        correlationId,
      },
    });
  };
  app.use(errorHandler);

  let expireInterval: NodeJS.Timeout | null = null;
  if (options.startCacheRefreshLoop !== false) {
    expireInterval = setInterval(() => {
      void queries.expireStaleChallenges().catch((err) => {
        logErrorWithId("expireStaleChallenges", err);
      });
      void queries.pruneRateLimitBuckets().catch((err) => {
        logErrorWithId("pruneRateLimitBuckets", err);
      });
    }, 5 * 60 * 1000);
    cache.start();
  }

  async function shutdown(): Promise<void> {
    if (expireInterval) clearInterval(expireInterval);
    cache.stop();
    await mcp?.close().catch((err) => {
      logErrorWithId("mcp.shutdown", err);
    });
    if (ownsPool) {
      await pool.end().catch((err) => {
        logErrorWithId("pool.shutdown", err);
      });
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
