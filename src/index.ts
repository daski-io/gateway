import { loadConfig } from "./config.js";
import { createViemChainReader } from "./chain/viemReader.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const reader = createViemChainReader({
    rpcUrl: config.baseRpcUrl,
    chainId: config.chainId,
    identityRegistryAddress: config.identityRegistryAddress,
    providerRegistryAddress: config.providerRegistryAddress,
    paymentRouterAddress: config.paymentRouterAddress,
    x402AdapterAddress: config.x402AdapterAddress,
    usdcAddress: config.usdcAddress,
    facilitatorPrivateKey: config.facilitatorPrivateKey,
    easAddress: config.easAddress,
  });

  const bundle = await createApp({ config, reader });

  // Await an initial discovery refresh so /health and /discover have data
  // before we accept any HTTP traffic. We log on failure but still start
  // listening — the periodic refresh loop inside the cache may recover.
  try {
    await bundle.cache.refresh();
  } catch (err) {
    console.error("initial cache refresh failed:", err);
  }

  const server = bundle.app.listen(config.port, () => {
    console.log(
      `daski-gateway listening on :${config.port} (chain ${config.chainId}, mcp ${
        config.mcpEnabled ? config.mcpPath : "off"
      })`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down`);
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
