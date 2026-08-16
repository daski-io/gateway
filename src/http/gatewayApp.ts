import express, { type Express } from "express";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { McpWiring } from "../mcp/httpTransport.js";
import type { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";
import { ViemMarketplaceChainReader } from "../marketplace/reader.js";
import { createMarketplaceRouter } from "../marketplace/routes.js";
import { CdpStandardFacilitator } from "../standardRail/facilitator.js";
import { StandardChainEvidence } from "../standardRail/evidence.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import { createStandardRailMcp } from "../standardRail/mcp.js";
import { createStandardMetaRouter } from "../standardRail/meta.js";
import { createStandardRailRouter } from "../standardRail/routes.js";
import { StandardRailService } from "../standardRail/service.js";
import { logErrorWithId } from "../util/errorWrap.js";
import { sendBodyParserError } from "./bodyErrors.js";
import { configureMiddleware } from "./middleware.js";

interface RateLimitStore {
  consumeRateLimitBucket(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: Date }>;
}

export interface StandardGatewayHttpOptions {
  config: Config;
  pool: Pool;
  federationPermitPool?: Pool;
  lifecycle: ApplicationLifecycle;
  standardRailConfig: StandardRailConfig;
  rateLimitStore: RateLimitStore;
  a2aFetch?: typeof fetch;
}

function requireStandardJson(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.method !== "POST" && req.method !== "PUT") {
    next();
    return;
  }
  const mediaType = req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = req.header("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    res.status(415).json({
      error: {
        code: "STANDARD_JSON_REQUIRED",
        message: "Standard-rail requests require uncompressed application/json.",
      },
    });
    return;
  }
  next();
}

export async function createStandardGatewayHttp(
  options: StandardGatewayHttpOptions,
): Promise<{ app: Express; mcp: McpWiring | null; standardRailStop: () => Promise<void> }> {
  const app = express();
  app.use(requireStandardJson);
  configureMiddleware(app, options.rateLimitStore, options.config, options.standardRailConfig);
  app.use((req, res, next) => {
    if (
      options.lifecycle.isStopping() &&
      req.path !== "/health/live" &&
      req.path !== "/health/ready"
    ) {
      res.status(503).json({
        error: { code: "SHUTTING_DOWN", message: "Gateway is shutting down." },
      });
      return;
    }
    next();
  });
  const facilitator = new CdpStandardFacilitator(options.standardRailConfig);
  const evidence = new StandardChainEvidence(
    options.standardRailConfig,
    options.config.chainId === 8453 ? base : baseSepolia,
  );
  const standardRail = new StandardRailService(
    options.config,
    options.standardRailConfig,
    options.pool,
    facilitator,
    evidence,
    options.a2aFetch,
    options.federationPermitPool,
  );
  const marketplace = new ViemMarketplaceChainReader(
    options.config,
    options.standardRailConfig,
    options.config.chainId === 8453 ? base : baseSepolia,
  );
  await standardRail.initialize();
  app.use(createStandardMetaRouter({
    config: options.config,
    pool: options.pool,
    lifecycle: options.lifecycle,
    service: standardRail,
  }));
  app.use(createMarketplaceRouter(marketplace));
  app.use(createStandardRailRouter(standardRail, options.config.publicUrl));
  const mcp = options.config.mcpEnabled
    ? await createStandardRailMcp(app, options.config, standardRail, marketplace)
    : null;
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(error);
    if (sendBodyParserError(error, res)) return;
    const correlationId = logErrorWithId("http.request", error);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error", correlationId },
    });
  });
  return { app, mcp, standardRailStop: () => standardRail.stop() };
}
