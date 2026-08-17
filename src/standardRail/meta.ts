import { Router } from "express";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";
import { GATEWAY_VERSION } from "../version.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardRailService } from "./service.js";

export function createStandardMetaRouter(args: {
  config: Config;
  pool: Pool;
  lifecycle: ApplicationLifecycle;
  service: StandardRailService;
  railConfig: StandardRailConfig;
}): Router {
  const router = Router();
  router.get("/health/live", (_req, res) => {
    res.json({ status: "alive", version: GATEWAY_VERSION });
  });
  router.get("/health/ready", async (_req, res) => {
    const databaseReady = await args.pool.query("SELECT 1").then(() => true, () => false);
    const admissionOpen = args.service.isAdmissionOpen();
    const dependenciesReady = args.service.areDependenciesReady();
    const operations = databaseReady ? await args.service.operationalHealth().catch(() => null) : null;
    const ready = databaseReady && admissionOpen && dependenciesReady && !args.lifecycle.isStopping();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unready",
      version: GATEWAY_VERSION,
      rail: "standard-exact-evm",
      railProfileHash: args.service.railProfileHash,
      dependencies: {
        database: databaseReady ? "ready" : "unready",
        admission: admissionOpen ? "ready" : "expired",
        standardRail: dependenciesReady ? "ready" : "unready",
      },
      operations,
    });
  });
  router.get("/.well-known/daski-chain.json", async (_req, res, next) => {
    try { res.json({
      version: 2,
      chainId: args.config.chainId,
      network: args.config.network,
      paymentRail: {
        scheme: "exact",
        network: args.config.x402Network,
        asset: args.config.usdc.address,
        transferMethod: "eip3009",
        activeRailProfileHash: args.service.railProfileHash,
        activeRailProfileUrl:
          `${args.config.publicUrl}/public/v2/artifacts/${args.service.railProfileHash}`,
      },
      contracts: {
        identityRegistry: args.config.marketplaceContracts.identityRegistry,
        agentIndex: args.config.marketplaceContracts.agentIndex,
        providerRegistry: args.config.marketplaceContracts.providerRegistry,
        serviceRegistry: args.config.marketplaceContracts.serviceRegistry,
        validationRegistry: args.config.marketplaceContracts.validationRegistry,
        reputationStorage: args.config.marketplaceContracts.reputationStorage,
        eas: args.railConfig.easAddress,
        usdc: args.config.usdc.address,
      },
      outcomes: await args.service.publicOutcomes(),
    }); } catch (error) { next(error); }
  });
  router.get("/.well-known/mcp.json", (_req, res) => {
    res.json({
      name: "daski-gateway",
      version: GATEWAY_VERSION,
      description: "Daski outcome marketplace over standard x402 Exact-EVM.",
      transport: { type: "streamable-http", url: `${args.config.publicUrl}${args.config.mcpPath}` },
      tools: [
        "daski_list_providers",
        "daski_get_provider",
        "daski_get_service",
        "daski_resolve_agent",
        "daski_list_outcomes",
        "daski_get_outcome",
        "daski_buy_outcome",
        "daski_list_my_orders",
        "daski_get_my_reputation",
        "daski_list_assets",
        "daski_use_asset",
        "daski_get_order_status",
        "daski_submit_order_input",
        "daski_cancel_order",
        "daski_get_order_artifact",
        "daski_contact_order_support",
        "daski_confirm_delivery",
        "daski_revoke_delivery_confirmation",
      ],
    });
  });
  router.get(["/llms.txt", "/llms-full.txt", "/skill.md", "/SKILL.md"], (_req, res) => {
    res.type("text/markdown").send([
      "# Daski standard outcome rail",
      "",
      "Use `daski_buy_outcome` for both the unpaid challenge and identical paid retry.",
      "Use the separately named order tools for status, input, cancellation, artifacts, and support.",
      "Each order action is a challenge/sign/retry exchange authorized by the payer wallet.",
      "Payments are standard x402 V2 Exact-EVM transfers to immutable outcome splitters.",
      "ERC-8004 identity and the Daski provider/service catalogs remain independent of the payment rail.",
      "Standard-order reputation is recorded independently after finalized x402 evidence.",
      "There is no separate paid task submission or payment-time registration.",
      `Network: ${args.config.x402Network}`,
    ].join("\n"));
  });
  return router;
}
