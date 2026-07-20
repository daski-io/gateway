import type { Express } from "express";
import type { ChainReader } from "./chain/reader.js";
import type { Config } from "./config.js";
import { createPool, runMigrations, type Pool } from "./db/pool.js";
import { createQueries, type Queries } from "./db/queries.js";
import { DiscoveryCache, type FetchFn } from "./discovery/cache.js";
import { CatalogEmbeddingSynchronizer } from "./discovery/embeddingSync.js";
import { xenovaEmbedder, type Embedder } from "./discovery/embeddings.js";
import { createGatewayHttp } from "./http/gatewayApp.js";
import type { FetchAgentCardOptions } from "./identity/fetch-agent-card.js";
import { ChainEventsIndexer } from "./indexer/chainEvents.js";
import type { McpWiring } from "./mcp/server.js";
import { ReputationMirrorWorker } from "./reputation/worker.js";
import { startBackgroundRuntime } from "./runtime/backgroundRuntime.js";
import { logErrorWithId } from "./util/errorWrap.js";
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
  reconcileInterval: NodeJS.Timeout | null;
  reputationWorker: ReputationMirrorWorker;
  indexer: ChainEventsIndexer;
  shutdown(): Promise<void>;
}

export async function createApp(options: CreateAppOptions): Promise<AppBundle> {
  const { config, reader } = options;
  const pool = options.pool ?? createPool({ connectionString: config.databaseUrl });
  const ownsPool = options.pool === undefined;
  await runMigrations(pool);
  const queries = createQueries(pool);
  const reputationWorker = new ReputationMirrorWorker({ config, reader, queries });
  const indexer = new ChainEventsIndexer(reader, queries);
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
  void embedder?.warmup?.().catch((error) => logErrorWithId("embedder.warmup", error));
  const { app, mcp } = await createGatewayHttp({
    ...options,
    pool,
    queries,
    cache,
    embedder,
    embeddingSync,
    reputationWorker,
    indexer,
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

  async function shutdown(): Promise<void> {
    background.stop();
    await mcp?.close().catch((error) => logErrorWithId("mcp.shutdown", error));
    await embeddingSync?.waitForIdle();
    if (ownsPool) {
      await pool.end().catch((error) => logErrorWithId("pool.shutdown", error));
    }
  }

  return {
    app,
    cache,
    pool,
    queries,
    embedder,
    mcp,
    expireInterval: background.expireInterval,
    reconcileInterval: background.reconcileInterval,
    reputationWorker,
    indexer,
    shutdown,
  };
}
