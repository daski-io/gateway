import { loadConfig } from "./config.js";
import { createViemChainReader } from "./chain/viemReader.js";
import { AutoMockChainReader } from "./chain/autoMockReader.js";
import { createApp } from "./app.js";
import type { ChainReader } from "./chain/reader.js";
import { logger } from "./util/logger.js";

async function main() {
  const config = loadConfig();

  // CHAIN_MODE=mock swaps the on-chain reader for an in-process auto-success
  // stub. Used by daski-test's `e2e:local:managed` orchestration so the
  // gateway never reaches a real RPC. The placeholder contract addresses
  // (USDC_ADDRESS, IDENTITY_REGISTRY_ADDRESS, …) must agree with daski-test's
  // runtimeConfig.LOCAL_PLACEHOLDER_CONTRACTS so EIP-712 signatures the
  // buyer produces verify against the same domain the gateway bakes into
  // PaymentRequirements.
  let reader: ChainReader;
  if (config.chainMode === "mock") {
    const providerWallet = config.mockProviderWalletAddress;
    const providerAgentId = config.mockProviderAgentId;
    const providerAgentUri = config.mockProviderAgentUri;
    const defaultBuyerAgentId = config.mockBuyerAgentId;
    reader = new AutoMockChainReader({
      tokenAddress: config.usdcAddress,
      providerWalletAddress: providerWallet,
      providerAgentId,
      providerAgentUri,
      defaultBuyerAgentId,
    });
    // The provider's whitelist gate filters /discover; in mock mode the
    // operator might forget to set WHITELISTED_AGENT_IDS, in which case
    // /discover would return empty. Auto-allow the mock provider so the
    // orchestrated e2e finds it without extra env wiring.
    if (config.whitelistedAgentIds.length === 0) {
      config.whitelistedAgentIds.push(providerAgentId);
    }
    logger.info(
      `daski-gateway CHAIN_MODE=mock — using AutoMockChainReader ` +
        `(provider agentId=${providerAgentId}, agentURI=${providerAgentUri}, ` +
        `buyer agentId=${defaultBuyerAgentId})`,
    );
  } else {
    reader = createViemChainReader({
      rpcUrl: config.baseRpcUrl,
      chainId: config.chainId,
      identityRegistryAddress: config.identityRegistryAddress,
      agentIndexAddress: config.agentIndexAddress,
      providerRegistryAddress: config.providerRegistryAddress,
      paymentRouterAddress: config.paymentRouterAddress,
      x402AdapterAddress: config.x402AdapterAddress,
      usdcAddress: config.usdcAddress,
      facilitatorPrivateKey: config.facilitatorPrivateKey,
      easAddress: config.easAddress,
      reputationStorageAddress: config.reputationStorageAddress,
      reputationRegistryAddress: config.reputationRegistryAddress,
    });
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

  const bundle = await createApp({ config, reader });

  // Await an initial discovery refresh so readiness and /discover have data
  // before we accept any HTTP traffic. We log on failure but still start
  // listening — the periodic refresh loop inside the cache may recover.
  try {
    await bundle.cache.refresh();
  } catch (err) {
    logger.error("initial cache refresh failed", err);
  }

  const server = bundle.app.listen(config.port, () => {
    logger.info(
      `daski-gateway listening on :${config.port} (chain ${config.chainId}, mcp ${
        config.mcpEnabled ? config.mcpPath : "off"
      })`,
    );
  });

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, shutting down`);
    server.close();
    await bundle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal startup failure", err);
  process.exit(1);
});
