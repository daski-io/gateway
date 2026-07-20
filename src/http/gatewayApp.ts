import express, { type ErrorRequestHandler, type Express } from "express";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { CatalogEmbeddingSynchronizer } from "../discovery/embeddingSync.js";
import type { Embedder } from "../discovery/embeddings.js";
import { createDiscoveryRouter } from "../discovery/routes.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import { createIdentityRouter } from "../identity/routes.js";
import { createMcpServer, type McpWiring } from "../mcp/server.js";
import { createBazaarRouter } from "../payment/bazaar.js";
import { createConfirmRouter } from "../payment/confirm.js";
import { createExternalFacilitatorClient } from "../payment/externalFacilitator.js";
import { createFacilitatorRouter } from "../payment/facilitator.js";
import { createPrepRouter } from "../payment/prep.js";
import { createPurchaseRouter } from "../payment/routes.js";
import { createPublicRouter } from "../public/routes.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { safeFetch } from "../util/urlSafety.js";
import { sendBodyParserError } from "./bodyErrors.js";
import { createMetaRouter } from "./metaRoutes.js";
import { configureMiddleware } from "./middleware.js";

export interface GatewayHttpOptions {
  config: Config;
  reader: ChainReader;
  cache: DiscoveryCache;
  queries: Queries;
  reputationWorker: ReputationMirrorWorker;
  indexer: ChainEventsIndexer;
  pool: Pool;
  embedder: Embedder | null;
  embeddingSync: CatalogEmbeddingSynchronizer | null;
  a2aFetch?: typeof fetch;
  a2aTimeoutMs?: number;
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
  externalFacilitatorFetch?: typeof fetch;
  mcpMaxSessions?: number;
  mcpMaxSessionsPerClient?: number;
  mcpSessionIdleTtlMs?: number;
  mcpSessionSweepIntervalMs?: number;
}

export async function createGatewayHttp(
  options: GatewayHttpOptions,
): Promise<{ app: Express; mcp: McpWiring | null }> {
  const { config, reader, cache, queries, reputationWorker } = options;
  const app = express();
  configureMiddleware(app, queries, config);
  app.use(
    createMetaRouter({
      config,
      cache,
      embedder: options.embedder,
      pool: options.pool,
      indexer: options.indexer,
      reputationWorker,
    }),
  );
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
  app.use(createConfirmRouter({ config, reader, queries, reputationWorker }));
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
        reputationWorker,
        pool: options.pool,
        embedder: options.embedder,
        embeddingSync: options.embeddingSync,
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
    if (res.headersSent) return next(error);
    if (sendBodyParserError(error, res)) return;
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", correlationId },
    });
  };
  app.use(errorHandler);
  return { app, mcp };
}
