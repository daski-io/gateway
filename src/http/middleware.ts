import cors from "cors";
import express, {
  type Express,
  type Request,
  type RequestHandler,
} from "express";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { rateLimit, securityHeaders } from "../util/security.js";
import { isHexAddress } from "../util/evmValidation.js";
import { captureRawJsonBody } from "./rawJsonBody.js";
import {
  captureBazaarRequestContext,
  clearBazaarRequestContext,
  hasBazaarPaymentSignature,
} from "./bazaarRequestContext.js";

const MCP_STATE_CHANGE_TOOLS = new Set([
  "daski_buy_service",
  "daski_confirm_delivery",
  "daski_register_agent",
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

function forPaidPurchaseRetry(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (hasBazaarPaymentSignature(req)) {
      middleware(req, res, next);
      return;
    }
    next();
  };
}

function captureBazaarContext(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): void {
  captureBazaarRequestContext(req);
  const cleanup = () => clearBazaarRequestContext(req);
  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
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

function rejectBazaarAlternateFraming(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
): void {
  const bodyLimit = req.originalUrl.startsWith("/x402/v1/orders")
    ? 64 * 1024
    : 1024;
  const contentLength = req.headers["content-length"];
  if (
    req.headers["content-encoding"] !== undefined ||
    req.headers["transfer-encoding"] !== undefined ||
    Array.isArray(contentLength) ||
    (contentLength !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
        BigInt(contentLength) > BigInt(bodyLimit)))
  ) {
    clearBazaarRequestContext(req);
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "invalid_bazaar_request_framing" });
    return;
  }
  next();
}

export function configureMiddleware(
  app: Express,
  queries: Queries,
  config: Config,
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
        "MCP-Protocol-Version",
      ],
      // Reflect the browser's requested header list. Modern MCP adds
      // Mcp-Method, Mcp-Name, and schema-derived Mcp-Param-* headers, whose
      // complete names cannot be enumerated ahead of time.
    }),
  );

  app.use(
    ["/x402/v1/outcomes", "/x402/v1/orders"],
    captureBazaarContext,
  );

  if (config.nodeEnv !== "test") {
    configurePreParserRateLimits(app, queries, config);
  }
  app.use(
    ["/x402/v1/outcomes", "/x402/v1/orders"],
    rejectBazaarAlternateFraming,
  );
  app.use(express.json({ limit: "1mb", verify: captureRawJsonBody }));
  if (config.nodeEnv !== "test") {
    app.use(
      ["/x402/v1/orders"],
      rateLimit({
        windowMs: 60_000,
        max: 30,
        namespace: "bazaar-lifecycle-domain",
        keyGenerator: bazaarLifecycleDomainRateKey,
        store: queries,
      }),
    );
    configureParsedMcpRateLimits(app, queries, config);
  }
}

export function bazaarLifecycleDomainRateKey(request: Request): string {
  const body = asRecord(request.body);
  const envelope = asRecord(body?.envelope);
  const payload = asRecord(envelope?.payload);
  const authorization = asRecord(payload?.authorization);
  const domain = asRecord(authorization?.domain);
  const candidate = body?.payTo ?? domain?.verifyingContract;
  return isHexAddress(candidate) ? candidate.toLowerCase() : "invalid";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function configurePreParserRateLimits(
  app: Express,
  queries: Queries,
  config: Config,
): void {
  addRateLimits(
    app,
    ["/purchase", "/x402/v1/outcomes"],
    {
      namespace: "payment-resource",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  app.use(
    ["/purchase", "/x402/v1/outcomes"],
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
    ["/purchase", "/x402/v1/outcomes"],
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
  addRateLimits(
    app,
    ["/verify"],
    {
      namespace: "facilitator-verify",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(
    app,
    ["/settle"],
    {
      namespace: "facilitator-settle",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(
    app,
    ["/confirm", "/register-transaction", "/register-prep"],
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
    ["/x402/v1/orders"],
    {
      namespace: "bazaar-lifecycle",
      perClient: 30,
      global: config.stateChangeGlobalMaxPerMinute,
      store: queries,
    },
  );
  addRateLimits(
    app,
    ["/.well-known/daski-bazaar-lifecycle-domains-v1.json"],
    {
      namespace: "bazaar-lifecycle-registry",
      perClient: 10,
      global: 60,
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
