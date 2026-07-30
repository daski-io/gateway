import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { reconcileBroadcastSettlements } from "../payment/settlementReconciler.js";
import { reconcileBuyerConfirmations } from "../payment/confirmationReconciler.js";

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
  stopAndDrain(): Promise<void>;
}

export function startBackgroundRuntime(
  options: BackgroundRuntimeOptions,
): BackgroundRuntime {
  let expireInterval: NodeJS.Timeout | null = null;
  let settlementReconcileInterval: NodeJS.Timeout | null = null;
  let stopping = false;
  let reconciliation: Promise<void> | null = null;
  let maintenance: Promise<void> | null = null;
  const reconcile = async () => {
    if (stopping || reconciliation) return;
    const operation = Promise.all([
      reconcileBroadcastSettlements(
        options.reader,
        options.queries,
        options.config,
      ),
      reconcileBuyerConfirmations(
        options.reader,
        options.queries,
        options.reputationWorker,
      ),
    ])
      .then(() => undefined)
      .catch((error) => {
        logErrorWithId("reconcileBroadcastSettlements", error);
      });
    reconciliation = operation;
    try {
      await operation;
    } finally {
      if (reconciliation === operation) reconciliation = null;
    }
  };
  const maintain = async () => {
    if (stopping || maintenance) return;
    const operation = maintainPaymentChallenges(options);
    maintenance = operation;
    try {
      await operation;
    } finally {
      if (maintenance === operation) maintenance = null;
    }
  };
  if (options.enabled) {
    expireInterval = setInterval(() => void maintain(), 5 * 60 * 1000);
    settlementReconcileInterval = setInterval(
      () => void reconcile(),
      30_000,
    );
    void reconcile();
    options.cache.start();
    options.indexer.start();
    options.reputationWorker.start();
  }
  return {
    expireInterval,
    settlementReconcileInterval,
    async stopAndDrain() {
      stopping = true;
      if (expireInterval) clearInterval(expireInterval);
      if (settlementReconcileInterval) clearInterval(settlementReconcileInterval);
      await Promise.all([
        options.cache.stopAndDrain(),
        options.indexer.stopAndDrain(),
        options.reputationWorker.stopAndDrain(),
        reconciliation,
        maintenance,
      ]);
    },
  };
}

async function maintainPaymentChallenges(
  options: BackgroundRuntimeOptions,
): Promise<void> {
  await Promise.all([
    options.queries
      .expireStaleChallenges()
      .then(() =>
        options.queries.deleteExpiredChallenges(
          options.config.challengeRetentionSeconds,
        ),
      )
      .catch((error) => {
        logErrorWithId("maintainPaymentChallenges", error);
      }),
    options.queries.pruneRateLimitBuckets().catch((error) => {
      logErrorWithId("pruneRateLimitBuckets", error);
    }),
  ]);
}
