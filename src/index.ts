import { loadConfig } from "./config.js";
import { createViemChainReader } from "./chain/viemReader.js";
import { AutoMockChainReader } from "./chain/autoMockReader.js";
import { createApp } from "./app.js";
import { ChainEventsIndexer } from "./indexer/chainEvents.js";
import type { ChainReader } from "./chain/reader.js";
import type { Hex } from "./types.js";

async function main() {
  const config = loadConfig();

  // CHAIN_MODE=mock swaps the on-chain reader for an in-process auto-success
  // stub. Used by daski-test's `e2e:local:managed` orchestration so the
  // gateway never reaches a real RPC. The placeholder contract addresses
  // (USDC_ADDRESS, IDENTITY_REGISTRY_ADDRESS, …) must agree with daski-test's
  // runtimeConfig.LOCAL_PLACEHOLDER_CONTRACTS so EIP-712 signatures the
  // buyer produces verify against the same domain the gateway bakes into
  // PaymentRequirements.
  const chainMode = process.env.CHAIN_MODE ?? "live";
  let reader: ChainReader;
  if (chainMode === "mock") {
    const providerWallet =
      (process.env.MOCK_PROVIDER_WALLET_ADDRESS as Hex | undefined) ??
      (("0x" + "11".repeat(20)) as Hex);
    const providerAgentId = BigInt(process.env.MOCK_PROVIDER_AGENT_ID ?? "1");
    const providerAgentUri =
      process.env.MOCK_PROVIDER_AGENT_URI ??
      "http://localhost:4040/.well-known/agent.json";
    const defaultBuyerAgentId = BigInt(
      process.env.MOCK_BUYER_AGENT_ID ?? "99",
    );
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
    console.log(
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
      directAdapterAddress: config.directAdapterAddress,
    });
  }

  const bundle = await createApp({ config, reader });

  // Await an initial discovery refresh so /health and /discover have data
  // before we accept any HTTP traffic. We log on failure but still start
  // listening — the periodic refresh loop inside the cache may recover.
  try {
    await bundle.cache.refresh();
  } catch (err) {
    console.error("initial cache refresh failed:", err);
  }

  // Chain-events indexer: mirrors PaymentSettled events into the gateway
  // DB so /activity and per-service recentPurchases include transactions
  // that settled outside this gateway. First tick fires synchronously
  // inside start(); the interval continues at 5s cadence.
  const indexer = new ChainEventsIndexer(reader, bundle.queries);
  indexer.start();

  const server = bundle.app.listen(config.port, () => {
    console.log(
      `daski-gateway listening on :${config.port} (chain ${config.chainId}, mcp ${
        config.mcpEnabled ? config.mcpPath : "off"
      })`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
    indexer.stop();
    server.close();
    await bundle.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
