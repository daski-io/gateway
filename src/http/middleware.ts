import cors from "cors";
import express, {
  type Express,
  type RequestHandler,
} from "express";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { rateLimit, securityHeaders } from "../util/security.js";

const MCP_STATE_CHANGE_TOOLS = new Set([
  "daski_buy_service",
  "daski_confirm_delivery",
  "daski_purchase",
  "daski_register_agent",
  "daski_settle_payment",
  "daski_submit_task",
]);

function forMcpStateChange(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const requests = Array.isArray(req.body) ? req.body : [req.body];
    const hasStateChange = requests.some((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const body = value as {
        method?: unknown;
        params?: { name?: unknown };
      };
      return (
        body.method === "tools/call" &&
        typeof body.params?.name === "string" &&
        MCP_STATE_CHANGE_TOOLS.has(body.params.name)
      );
    });
    if (hasStateChange) {
      middleware(req, res, next);
      return;
    }
    next();
  };
}

function addRateLimits(
  app: Express,
  paths: string[],
  options: {
    namespace: string;
    perClient: number;
    global: number;
    store: Queries;
  },
): void {
  app.use(
    paths,
    rateLimit({
      windowMs: 60_000,
      max: options.perClient,
      namespace: options.namespace,
      store: options.store,
    }),
  );
  app.use(
    paths,
    rateLimit({
      windowMs: 60_000,
      max: options.global,
      namespace: `${options.namespace}-global`,
      keyScope: "global",
      store: options.store,
    }),
  );
}

export function configureMiddleware(
  app: Express,
  queries: Queries,
  config: Config,
): void {
  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);
  app.use(cors({ origin: "*" }));

  if (config.nodeEnv !== "test") {
    configurePreParserRateLimits(app, queries, config);
  }
  app.use(express.json({ limit: "1mb" }));
  if (config.nodeEnv !== "test") {
    configureParsedMcpRateLimits(app, queries, config);
  }
}

function configurePreParserRateLimits(
  app: Express,
  queries: Queries,
  config: Config,
): void {
  addRateLimits(
    app,
    [
      "/purchase",
      "/verify",
      "/settle",
      "/confirm",
      "/register-transaction",
      "/register-prep",
      "/x402",
    ],
    {
      namespace: "state-change",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(
    app,
    ["/identity/by-wallet", "/eas/nonce", "/confirm-prep"],
    {
      namespace: "rpc-read",
      perClient: 60,
      global: config.rpcReadMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(
    app,
    [
      "/public",
      "/discover",
      "/providers",
      "/skill.md",
      "/SKILL.md",
      "/.well-known",
      "/llms.txt",
      "/llms-full.txt",
      "/health/ready",
    ],
    {
      namespace: "public-read",
      perClient: config.publicReadMaxPerMinute,
      global: config.publicReadGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(app, [config.mcpPath], {
    namespace: "mcp",
    perClient: 60,
    global: config.mcpGlobalMaxPerMinute,
    store: queries,
  });
}

function configureParsedMcpRateLimits(
  app: Express,
  queries: Queries,
  config: Config,
): void {
  app.post(
    config.mcpPath,
    forMcpStateChange(
      rateLimit({
        windowMs: 60_000,
        max: 30,
        namespace: "state-change",
        store: queries,
      }),
    ),
  );
  app.post(
    config.mcpPath,
    forMcpStateChange(
      rateLimit({
        windowMs: 60_000,
        max: config.stateChangeGlobalMaxPerMinute,
        namespace: "state-change-global",
        keyScope: "global",
        store: queries,
      }),
    ),
  );
}
