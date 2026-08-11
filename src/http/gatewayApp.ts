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
import { createConfirmRouter } from "../payment/confirm.js";
import { createFacilitatorRouter } from "../payment/facilitator.js";
import { createPrepRouter } from "../payment/prep.js";
import { createPurchaseRouter } from "../payment/routes.js";
import { DaskiFacilitatorService } from "../payment/daskiFacilitator.js";
import type { ChainDeploymentReadinessProbe } from "../payment/deploymentReadiness.js";
import { createPublicRouter } from "../public/routes.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { sendBodyParserError } from "./bodyErrors.js";
import { createMetaRouter } from "./metaRoutes.js";
import { configureMiddleware } from "./middleware.js";
import type { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { createBazaarCompatibilityRouter } from "../bazaar/router.js";
import type { BazaarCompatibilityWiring } from "../bazaar/types.js";
import type { BazaarRecoveryRuntime } from "../bazaar/recovery.js";
import { clearRawJsonBody } from "./rawJsonBody.js";
import { clearBazaarRequestContext } from "./bazaarRequestContext.js";

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
  deploymentReadiness: ChainDeploymentReadinessProbe;
  lifecycle: ApplicationLifecycle;
  providerAuthority: ProviderAuthorityService;
  a2aFetch?: typeof fetch;
  a2aTimeoutMs?: number;
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
  bazaarCompatibility?: BazaarCompatibilityWiring;
}

export async function createGatewayHttp(
  options: GatewayHttpOptions,
): Promise<{
  app: Express;
  mcp: McpWiring | null;
  closeBazaar: () => Promise<void>;
  bazaarRecovery: BazaarRecoveryRuntime | null;
}> {
  const { config, reader, cache, queries, reputationWorker } = options;
  const app = express();
  const facilitator = new DaskiFacilitatorService({
    config,
    queries,
    reader,
    deploymentReadiness: options.deploymentReadiness,
    providerAuthority: options.providerAuthority,
    fetchAgentCardFn: options.buyerAgentCardFetch,
  });
  configureMiddleware(app, queries, config);
  app.use((req, res, next) => {
    if (
      options.lifecycle.isStopping() &&
      req.path !== "/health/live" &&
      req.path !== "/health/ready"
    ) {
      res.status(503).json({
        error: {
          code: "SHUTTING_DOWN",
          message: "Gateway is shutting down.",
        },
      });
      return;
    }
    next();
  });
  app.use(
    createMetaRouter({
      config,
      cache,
      embedder: options.embedder,
      pool: options.pool,
      indexer: options.indexer,
      reputationWorker,
      deploymentReadiness: options.deploymentReadiness,
      lifecycle: options.lifecycle,
    }),
  );
  let closeBazaar = () => Promise.resolve();
  let bazaarRecovery: BazaarRecoveryRuntime | null = null;
  if (options.bazaarCompatibility) {
    const bazaar = await createBazaarCompatibilityRouter({
      pool: options.pool,
      providerAuthority: options.providerAuthority,
      wiring: options.bazaarCompatibility,
      lifecycleDomainRetentionSeconds: config.taskRetentionSeconds,
      shutdownSignal: options.lifecycle.signal,
    });
    app.use(bazaar.router);
    closeBazaar = bazaar.close;
    bazaarRecovery = bazaar.recovery;
  }
  app.use(createDiscoveryRouter(cache, config));
  app.use(
    createPurchaseRouter({
      config,
      cache,
      queries,
      reader,
      deploymentReadiness: options.deploymentReadiness,
      facilitator,
      providerAuthority: options.providerAuthority,
      fetchAgentCardFn: options.buyerAgentCardFetch,
    }),
  );
  app.use(createConfirmRouter({ config, reader, queries, reputationWorker }));
  app.use(
    createFacilitatorRouter({ facilitator }),
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
        deploymentReadiness: options.deploymentReadiness,
        facilitator,
        providerAuthority: options.providerAuthority,
        reputationWorker,
        pool: options.pool,
        embedder: options.embedder,
        embeddingSync: options.embeddingSync,
        fetch: options.a2aFetch,
        a2aTimeoutMs: options.a2aTimeoutMs,
        buyerAgentCardFetch: options.buyerAgentCardFetch,
      })
    : null;
  const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    clearRawJsonBody(req);
    clearBazaarRequestContext(req);
    req.body = {};
    if (res.headersSent) return next(error);
    if (sendBodyParserError(error, res)) return;
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", correlationId },
    });
  };
  app.use(errorHandler);
  return { app, mcp, closeBazaar, bazaarRecovery };
}
