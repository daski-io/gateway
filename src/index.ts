import { loadConfig } from "./config.js";
import { logger } from "./util/logger.js";
import { withGracePeriod } from "./runtime/gracePeriod.js";
import { createStandardApp } from "./standardRail/app.js";
import { loadStandardRailConfig } from "./standardRail/config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const standardRailConfig = loadStandardRailConfig();
  const bundle = await createStandardApp({ config, standardRailConfig });
  const server = bundle.app.listen(config.port, () => {
    logger.info(
      `daski-gateway listening on :${config.port} (chain ${config.chainId}, rail standard, mcp ${
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
        await withGracePeriod(bundle.shutdown(httpClosed), config.shutdownGraceMs);
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

main().catch((error) => {
  logger.error("fatal startup failure", { error });
  process.exit(1);
});
