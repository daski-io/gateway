import cors from "cors";
import express, {
  type Express,
  type RequestHandler,
} from "express";
import type { Config } from "../config.js";
import { rateLimit, securityHeaders } from "../util/security.js";
import { assertNoDuplicateJsonKeys } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";

interface RateLimitStore {
  consumeRateLimitBucket(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; resetAt: Date }>;
}

const MCP_STATE_CHANGE_TOOLS = new Set([
  "daski_buy_outcome",
  "daski_get_order_status",
  "daski_submit_order_input",
  "daski_cancel_order",
  "daski_get_order_artifact",
  "daski_contact_order_support",
  "daski_use_asset",
  "daski_confirm_delivery",
  "daski_revoke_delivery_confirmation",
]);

const MCP_PROTECTED_READ_TOOLS = new Set([
  "daski_list_my_orders",
  "daski_get_my_reputation",
  "daski_list_assets",
]);

const MCP_WALLET_CHALLENGE_TOOLS = new Set([
  ...MCP_PROTECTED_READ_TOOLS,
  "daski_use_asset",
  "daski_confirm_delivery",
  "daski_revoke_delivery_confirmation",
]);

function forMcpStateChange(middleware: RequestHandler): RequestHandler {
  return forMcpTools(MCP_STATE_CHANGE_TOOLS, middleware);
}

function forMcpTools(names: ReadonlySet<string>, middleware: RequestHandler): RequestHandler {
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
        names.has(body.params.name)
      );
    });
    if (hasStateChange) {
      middleware(req, res, next);
      return;
    }
    next();
  };
}

function forPaidPurchaseRetry(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.get("PAYMENT-SIGNATURE")) {
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
    store: RateLimitStore;
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
  queries: RateLimitStore,
  config: Config,
  railConfig: StandardRailConfig,
): void {
  app.set("trust proxy", config.trustProxy);
  app.use(securityHeaders);
  app.use(
    cors({
      origin: "*",
      exposedHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-SIGNATURE",
        "PAYMENT-RESPONSE",
        "DASKI-ORDER-HANDLE",
        "DASKI-RAIL-PROFILE",
        "DASKI-RAIL-PROFILE-HASH",
        "MCP-Protocol-Version",
      ],
      // Reflect the browser's requested header list. Modern MCP adds
      // Mcp-Method, Mcp-Name, and schema-derived Mcp-Param-* headers, whose
      // complete names cannot be enumerated ahead of time.
    }),
  );

  if (config.nodeEnv !== "test") {
    configurePreParserRateLimits(app, queries, config, railConfig);
  }
  app.use(express.json({
    limit: "1mb",
    inflate: false,
    verify: (req, _res, buffer) => {
      if (buffer.length === 0) return;
      try {
        assertNoDuplicateJsonKeys(buffer.toString("utf8"));
      } catch {
        const error = new SyntaxError("Request JSON contains a duplicate key") as SyntaxError & { type: string };
        error.type = "entity.parse.failed";
        throw error;
      }
      (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
    },
  }));
  if (config.nodeEnv !== "test") {
    configureParsedMcpRateLimits(app, queries, config, railConfig);
    if (config.dynamicServiceRegistrationEnabled) {
      configureParsedRegistrationRateLimits(app, queries);
    }
  }
}

function configurePreParserRateLimits(
  app: Express,
  queries: RateLimitStore,
  config: Config,
  railConfig: StandardRailConfig,
): void {
  addRateLimits(
    app,
    ["/outcomes", "/uploads", "/orders"],
    {
      namespace: "payment-resource",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(app, ["/wallet"], {
    namespace: "wallet-challenge",
    perClient: railConfig.abuse.walletChallengesPerClientPerMinute,
    global: railConfig.abuse.walletChallengesGlobalPerMinute,
    store: queries,
  });
  app.use(
    "/outcomes",
    forPaidPurchaseRetry(
      rateLimit({
        windowMs: 60_000,
        max: 30,
        namespace: "payment-resource-retry",
        store: queries,
      }),
    ),
  );
  app.use(
    "/outcomes",
    forPaidPurchaseRetry(
      rateLimit({
        windowMs: 60_000,
        max: config.stateChangeGlobalMaxPerMinute,
        namespace: "payment-resource-retry-global",
        keyScope: "global",
        store: queries,
      }),
    ),
  );
  if (config.dynamicServiceRegistrationEnabled) {
    addRateLimits(app, ["/v1/service-registrations"], {
      namespace: "service-registration",
      perClient: 10,
      global: Math.min(config.stateChangeGlobalMaxPerMinute, 100),
      store: queries,
    });
    addRateLimits(app, ["/operator/v1"], {
      namespace: "catalog-operator",
      perClient: 30,
      global: Math.min(config.stateChangeGlobalMaxPerMinute, 100),
      store: queries,
    });
  }
  addRateLimits(
    app,
    [
      "/public/v2",
      "/public/v3",
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

function registrationResourceKey(req: express.Request): string {
  const body = req.body as {
    payload?: { providerAgentId?: unknown; registrationId?: unknown };
  } | undefined;
  const providerAgentId = body?.payload?.providerAgentId;
  if (
    typeof providerAgentId === "string" &&
    /^(?:0|[1-9]\d{0,77})$/.test(providerAgentId)
  ) return `provider:${providerAgentId}`;
  const registrationId = req.params.registrationId ?? body?.payload?.registrationId;
  if (
    typeof registrationId === "string" &&
    /^[0-9a-f-]{36}$/i.test(registrationId)
  ) return `registration:${registrationId.toLowerCase()}`;
  return "invalid";
}

function configureParsedRegistrationRateLimits(
  app: Express,
  queries: RateLimitStore,
): void {
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    namespace: "service-registration-resource",
    key: registrationResourceKey,
    store: queries,
  });
  app.post("/v1/service-registrations", limiter);
  app.post(
    "/v1/service-registrations/:registrationId/evidence",
    limiter,
  );
}

function configureParsedMcpRateLimits(
  app: Express,
  queries: RateLimitStore,
  config: Config,
  railConfig: StandardRailConfig,
): void {
  app.post(
    config.mcpPath,
    forMcpTools(
      MCP_WALLET_CHALLENGE_TOOLS,
      rateLimit({
        windowMs: 60_000,
        max: railConfig.abuse.walletChallengesPerClientPerMinute,
        namespace: "wallet-challenge",
        store: queries,
      }),
    ),
  );
  app.post(
    config.mcpPath,
    forMcpTools(
      MCP_WALLET_CHALLENGE_TOOLS,
      rateLimit({
        windowMs: 60_000,
        max: railConfig.abuse.walletChallengesGlobalPerMinute,
        namespace: "wallet-challenge-global",
        keyScope: "global",
        store: queries,
      }),
    ),
  );
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
  app.post(
    config.mcpPath,
    forMcpTools(
      MCP_PROTECTED_READ_TOOLS,
      rateLimit({ windowMs: 60_000, max: railConfig.abuse.protectedReadsPerPayerPerMinute,
        namespace: "protected-read", store: queries }),
    ),
  );
}
