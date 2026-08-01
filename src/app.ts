import type { Express } from "express";
import type { ChainReader } from "./chain/reader.js";
import type { Config } from "./config.js";
import {
  createDatabasePools,
  runMigrations,
  type DatabasePools,
  type Pool,
} from "./db/pool.js";
import { createQueries, type Queries } from "./db/queries.js";
import { DiscoveryCache, type FetchFn } from "./discovery/cache.js";
import { CatalogEmbeddingSynchronizer } from "./discovery/embeddingSync.js";
import { xenovaEmbedder, type Embedder } from "./discovery/embeddings.js";
import { createGatewayHttp } from "./http/gatewayApp.js";
import type { FetchAgentCardOptions } from "./identity/fetch-agent-card.js";
import {
  ChainEventsIndexer,
  type ProjectionReader,
} from "./indexer/chainEvents.js";
import type { McpWiring } from "./mcp/server.js";
import { sessionMetrics } from "./mcp/sessionMetrics.js";
import { ReputationMirrorWorker } from "./reputation/worker.js";
import { startBackgroundRuntime } from "./runtime/backgroundRuntime.js";
import { ChainDeploymentReadinessProbe } from "./payment/deploymentReadiness.js";
import { logErrorWithId } from "./util/errorWrap.js";
import { logger } from "./util/logger.js";
import { ApplicationLifecycle } from "./runtime/applicationLifecycle.js";
import { ProviderAuthorityService } from "./payment/providerAuthority.js";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as const;

export interface CreateAppOptions {
  config: Config;
  reader: ChainReader;
  // Dedicated reader for the chain-events indexer (own RPC transport via
  // CHAIN_INDEXER_RPC_URL). Unset = the indexer shares `reader`.
  projectionReader?: ProjectionReader;
  pools?: DatabasePools;
  embedder?: Embedder | null;
  agentCardFetch?: FetchFn;
  a2aFetch?: typeof fetch;
  a2aTimeoutMs?: number;
  startCacheRefreshLoop?: boolean;
  agentCardFetchTimeoutMs?: number;
  buyerAgentCardFetch?: FetchAgentCardOptions["fetchFn"];
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
  settlementReconcileInterval: NodeJS.Timeout | null;
  reputationWorker: ReputationMirrorWorker;
  indexer: ChainEventsIndexer;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  providerAuthority: ProviderAuthorityService;
  beginShutdown(): void;
  shutdown(httpClosed?: Promise<void>): Promise<void>;
}

export async function createApp(options: CreateAppOptions): Promise<AppBundle> {
  const { config, reader } = options;
  const pools =
    options.pools ??
    createDatabasePools({ connectionString: config.databaseUrl });
  const pool = pools.main;
  const ownsPools = options.pools === undefined;
  await runMigrations(pool);
  const queries = createQueries(pools);
  const reputationWorker = new ReputationMirrorWorker({ config, reader, queries });
  const indexer = new ChainEventsIndexer(
    options.projectionReader ?? reader,
    queries,
    {
      chainId: config.chainId,
      paymentRouterAddress: config.paymentRouterAddress,
      reputationStorageAddress:
        config.reputationStorageAddress ?? ZERO_ADDRESS,
      easAddress: config.easAddress,
      confirmationSchemaUid: config.easConfirmationSchemaUid,
      startBlock: config.chainIndexerStartBlock,
    },
    { pollIntervalMs: config.chainIndexerPollIntervalMs },
  );
  await indexer.initialize();
  const deploymentReadiness = new ChainDeploymentReadinessProbe(reader);
  const lifecycle = new ApplicationLifecycle();
  const embedder = options.embedder === null ? null : (options.embedder ?? xenovaEmbedder());
  const embeddingSync = embedder ? new CatalogEmbeddingSynchronizer(pool, embedder) : null;
  const cache = new DiscoveryCache({
    reader,
    whitelist: config.whitelistedAgentIds,
    refreshIntervalSeconds: config.cacheRefreshIntervalSeconds,
    maxCardStalenessSeconds: config.cacheMaxStalenessSeconds,
    fetch: options.agentCardFetch,
    agentCardFetchTimeoutMs: options.agentCardFetchTimeoutMs,
    maxA2AEntries: config.discoveryMaxA2AEntries,
    fetchConcurrency: config.discoveryFetchConcurrency,
    refreshDeadlineMs: config.discoveryRefreshDeadlineMs,
    onCatalogChanged: (_oldProviders, newProviders) => embeddingSync?.schedule(newProviders),
    logger,
  });
  const providerAuthority = new ProviderAuthorityService(cache, config);
  const embedderWarmup =
    embedder?.warmup?.().catch((error) => {
      logErrorWithId("embedder.warmup", error);
    }) ?? Promise.resolve();
  const { app, mcp } = await createGatewayHttp({
    ...options,
    pool,
    queries,
    cache,
    embedder,
    embeddingSync,
    reputationWorker,
    indexer,
    deploymentReadiness,
    lifecycle,
    providerAuthority,
  });
  const background = startBackgroundRuntime({
    enabled: options.startCacheRefreshLoop !== false,
    config,
    reader,
    queries,
    cache,
    indexer,
    reputationWorker,
  });

  let shutdownPromise: Promise<void> | null = null;
  function shutdown(
    httpClosed: Promise<void> = Promise.resolve(),
  ): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    lifecycle.beginShutdown();
    const backgroundDrain = background.stopAndDrain();
    // Railway redeploys on every main push — without this, every active
    // session's telemetry rollup dies with the process.
    sessionMetrics.stop();
    const mcpClose = mcp?.close() ?? Promise.resolve();
    shutdownPromise = (async () => {
      const drains = await Promise.allSettled([
        httpClosed,
        backgroundDrain,
        mcpClose,
      ]);
      // Closing the transport can finish in-flight tool calls. Flush only
      // after they have had a chance to update their session rollups.
      sessionMetrics.flushAll();
      const bootstrap = await Promise.allSettled([
        embedderWarmup,
        embeddingSync?.waitForIdle() ?? Promise.resolve(),
      ]);
      const poolClose = ownsPools
        ? await Promise.allSettled(
            Object.values(pools).map((databasePool) => databasePool.end()),
          )
        : [];
      const failure = [...drains, ...bootstrap, ...poolClose].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return shutdownPromise;
  }

  return {
    app,
    cache,
    pool,
    queries,
    embedder,
    mcp,
    expireInterval: background.expireInterval,
    settlementReconcileInterval: background.settlementReconcileInterval,
    reputationWorker,
    indexer,
    deploymentReadiness,
    providerAuthority,
    beginShutdown: () => lifecycle.beginShutdown(),
    shutdown,
  };
}
