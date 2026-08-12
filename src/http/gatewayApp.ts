import express, { type Express } from "express";
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
import type { StandardRailConfig } from "../standardRail/config.js";
import { CdpStandardFacilitator } from "../standardRail/facilitator.js";
import { StandardChainEvidence } from "../standardRail/evidence.js";
import { StandardRailService } from "../standardRail/service.js";
import { createStandardRailRouter } from "../standardRail/routes.js";
import { createStandardRailMcp } from "../standardRail/mcp.js";
import { createStandardMetaRouter } from "../standardRail/meta.js";
import { base, baseSepolia } from "viem/chains";

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
  standardRailConfig: StandardRailConfig | null;
}

export interface StandardGatewayHttpOptions {
  config: Config;
  pool: Pool;
  lifecycle: ApplicationLifecycle;
  standardRailConfig: StandardRailConfig;
  rateLimitStore: Pick<Queries, "consumeRateLimitBucket">;
  a2aFetch?: typeof fetch;
}

function requireStandardJson(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.method !== "POST" && req.method !== "PUT") {
    next();
    return;
  }
  const mediaType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = req.header("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    res.status(415).json({
      error: {
        code: "STANDARD_JSON_REQUIRED",
        message: "Standard-rail requests require uncompressed application/json.",
      },
    });
    return;
  }
  next();
}

export async function createStandardGatewayHttp(
  options: StandardGatewayHttpOptions,
): Promise<{ app: Express; mcp: McpWiring | null; standardRailStop: () => Promise<void> }> {
  const app = express();
  app.use(requireStandardJson);
  configureMiddleware(app, options.rateLimitStore, options.config);
  app.use((req, res, next) => {
    if (
      options.lifecycle.isStopping() &&
      req.path !== "/health/live" &&
      req.path !== "/health/ready"
    ) {
      res.status(503).json({
        error: { code: "SHUTTING_DOWN", message: "Gateway is shutting down." },
      });
      return;
    }
    next();
  });
  const standardFacilitator = new CdpStandardFacilitator(options.standardRailConfig);
  const evidence = new StandardChainEvidence(
    options.standardRailConfig,
    options.config.chainId === 8453 ? base : baseSepolia,
  );
  const standardRail = new StandardRailService(
    options.config,
    options.standardRailConfig,
    options.pool,
    standardFacilitator,
    evidence,
    options.a2aFetch,
  );
  await standardRail.initialize();
  app.use(createStandardMetaRouter({
    config: options.config,
    pool: options.pool,
    lifecycle: options.lifecycle,
    service: standardRail,
  }));
  app.use(createStandardRailRouter(standardRail, options.config.publicUrl));
  const mcp = options.config.mcpEnabled
    ? await createStandardRailMcp(app, options.config, standardRail)
    : null;
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    if (sendBodyParserError(error, res)) return;
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", correlationId },
    });
  });
  return { app, mcp, standardRailStop: () => standardRail.stop() };
}

export async function createGatewayHttp(
  options: GatewayHttpOptions,
): Promise<{ app: Express; mcp: McpWiring | null; standardRailStop?: () => Promise<void> }> {
  if (options.standardRailConfig) {
    return createStandardGatewayHttp({
      config: options.config,
      pool: options.pool,
      lifecycle: options.lifecycle,
      standardRailConfig: options.standardRailConfig,
      rateLimitStore: options.queries,
      a2aFetch: options.a2aFetch,
    });
  }
  const { config, reader, cache, queries, reputationWorker } = options;
  const app = express();
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
  const facilitator = new DaskiFacilitatorService({
    config,
    queries,
    reader,
    deploymentReadiness: options.deploymentReadiness,
    providerAuthority: options.providerAuthority,
    fetchAgentCardFn: options.buyerAgentCardFetch,
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
  function errorHandler(error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) {
    if (res.headersSent) return next(error);
    if (sendBodyParserError(error, res)) return;
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", correlationId },
    });
  }
  app.use(errorHandler);
  return { app, mcp };
}
