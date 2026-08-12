import { loadConfig } from "./config.js";
import { AutoMockChainReader } from "./chain/autoMockReader.js";
import { createApp } from "./app.js";
import { logger } from "./util/logger.js";
import { withGracePeriod } from "./runtime/gracePeriod.js";
import {
  createConfiguredChainReader,
  createConfiguredProjectionReader,
} from "./chain/configuredReader.js";
import { loadStandardRailConfig } from "./standardRail/config.js";
import { createStandardApp } from "./standardRail/app.js";

async function main() {
  const config = loadConfig();
  const standardRailConfig = loadStandardRailConfig();

  if (standardRailConfig) {
    const bundle = await createStandardApp({ config, standardRailConfig });
    await listen(bundle, config, "standard");
    return;
  }

  // CHAIN_MODE=mock swaps the on-chain reader for an in-process auto-success
  // stub. Used by daski-test's `e2e:local:managed` orchestration so the
  // gateway never reaches a real RPC. The placeholder contract addresses
  // (USDC_ADDRESS, IDENTITY_REGISTRY_ADDRESS, …) must agree with daski-test's
  // runtimeConfig.LOCAL_PLACEHOLDER_CONTRACTS so EIP-712 signatures the
  // buyer produces verify against the same domain the gateway bakes into
  // PaymentRequirements.
  const reader = createConfiguredChainReader(config);
  if (reader instanceof AutoMockChainReader) {
    logger.info(
      `daski-gateway CHAIN_MODE=mock — using AutoMockChainReader ` +
        `(provider agentId=${config.mockProviderAgentId}, ` +
        `agentURI=${config.mockProviderAgentUri}, ` +
        `buyer agentId=${config.mockBuyerAgentId})`,
    );
  }

  // Canonical-feedback mirror status — one startup line so operators can
  // tell at a glance whether buyer confirmations will be mirrored to the
  // canonical ERC-8004 ReputationRegistry (mirror.ts logs per-call
  // failures, not per-call disabled states).
  const mirrorEnabled =
    config.chainMode !== "mock" && Boolean(config.reputationRegistryAddress);
  logger.info(
    mirrorEnabled
      ? `canonical ERC-8004 feedback mirror enabled (ReputationRegistry ${config.reputationRegistryAddress})`
      : `canonical ERC-8004 feedback mirror disabled (${
          config.chainMode === "mock"
            ? "CHAIN_MODE=mock"
            : "REPUTATION_REGISTRY_ADDRESS unset"
        })`,
  );

  const projectionReader = createConfiguredProjectionReader(config);
  if (projectionReader) {
    logger.info(
      "chain-events indexer on dedicated RPC route (CHAIN_INDEXER_RPC_URL)",
    );
  }
  const bundle = await createApp({ config, reader, projectionReader, standardRailConfig: null });

  // Await an initial discovery refresh so readiness and /discover have data
  // before we accept any HTTP traffic. We log on failure but still start
  // listening — the periodic refresh loop inside the cache may recover.
  if (!standardRailConfig) {
    try {
      await bundle.cache.refresh();
    } catch (err) {
      logger.error("initial cache refresh failed", { error: err });
    }
  }

  await listen(bundle, config, "native");
}

async function listen(
  bundle: {
    app: import("express").Express;
    beginShutdown(): void;
    shutdown(httpClosed?: Promise<void>): Promise<void>;
  },
  config: ReturnType<typeof loadConfig>,
  rail: "standard" | "native",
): Promise<void> {
  const server = bundle.app.listen(config.port, () => {
    logger.info(
      `daski-gateway listening on :${config.port} (chain ${config.chainId}, rail ${rail}, mcp ${
        config.mcpEnabled ? config.mcpPath : "off"
      })`,
    );
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info(`received ${signal}, shutting down`);
      bundle.beginShutdown();
      const httpClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      try {
        await withGracePeriod(
          bundle.shutdown(httpClosed),
          config.shutdownGraceMs,
        );
        process.exit(0);
      } catch (error) {
        logger.error("graceful shutdown failed", { error });
        process.exit(1);
      }
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal startup failure", { error: err });
  process.exit(1);
});
