import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { reconcileBroadcastSettlements } from "../payment/settlementReconciler.js";

interface BackgroundRuntimeOptions {
  enabled: boolean;
  config: Config;
  reader: ChainReader;
  queries: Queries;
  cache: DiscoveryCache;
  indexer: ChainEventsIndexer;
  reputationWorker: ReputationMirrorWorker;
}

export interface BackgroundRuntime {
  expireInterval: NodeJS.Timeout | null;
  settlementReconcileInterval: NodeJS.Timeout | null;
  stop(): void;
}

export function startBackgroundRuntime(
  options: BackgroundRuntimeOptions,
): BackgroundRuntime {
  let expireInterval: NodeJS.Timeout | null = null;
  let settlementReconcileInterval: NodeJS.Timeout | null = null;
  let reconciliationPending = false;
  const reconcile = () => {
    if (reconciliationPending) return;
    reconciliationPending = true;
    void reconcileBroadcastSettlements(
      options.reader,
      options.queries,
      options.config,
    )
      .catch((error) => {
        logErrorWithId("reconcileBroadcastSettlements", error);
      })
      .finally(() => {
        reconciliationPending = false;
      });
  };
  if (options.enabled) {
    expireInterval = setInterval(() => maintainPaymentChallenges(options), 5 * 60 * 1000);
    settlementReconcileInterval = setInterval(
      reconcile,
      30_000,
    );
    reconcile();
    options.cache.start();
    options.indexer.start();
    options.reputationWorker.start();
  }
  return {
    expireInterval,
    settlementReconcileInterval,
    stop() {
      if (expireInterval) clearInterval(expireInterval);
      if (settlementReconcileInterval) clearInterval(settlementReconcileInterval);
      options.cache.stop();
      options.indexer.stop();
      options.reputationWorker.stop();
    },
  };
}

function maintainPaymentChallenges(options: BackgroundRuntimeOptions): void {
  void options.queries
    .expireStaleChallenges()
    .then(() =>
      options.queries.deleteExpiredChallenges(
        options.config.challengeRetentionSeconds,
      ),
    )
    .catch((error) => {
      logErrorWithId("maintainPaymentChallenges", error);
    });
  void options.queries.pruneRateLimitBuckets().catch((error) => {
    logErrorWithId("pruneRateLimitBuckets", error);
  });
}
