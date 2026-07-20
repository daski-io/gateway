import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import { reconcileExternalSettlements } from "../payment/externalReconciler.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { logErrorWithId } from "../util/errorWrap.js";

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
  reconcileInterval: NodeJS.Timeout | null;
  stop(): void;
}

export function startBackgroundRuntime(
  options: BackgroundRuntimeOptions,
): BackgroundRuntime {
  let expireInterval: NodeJS.Timeout | null = null;
  let reconcileInterval: NodeJS.Timeout | null = null;
  if (options.enabled) {
    expireInterval = setInterval(() => maintainPaymentChallenges(options), 5 * 60 * 1000);
    if (options.config.directAdapterAddress) {
      const reconcile = () => {
        void reconcileExternalSettlements(options.reader, options.queries).catch((error) => {
          logErrorWithId("reconcileExternalSettlements", error);
        });
      };
      reconcile();
      reconcileInterval = setInterval(reconcile, 30_000);
    }
    options.cache.start();
    options.indexer.start();
    options.reputationWorker.start();
  }
  return {
    expireInterval,
    reconcileInterval,
    stop() {
      if (expireInterval) clearInterval(expireInterval);
      if (reconcileInterval) clearInterval(reconcileInterval);
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
