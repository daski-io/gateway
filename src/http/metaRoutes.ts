import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { hasMarketplaceService } from "../discovery/agentCard.js";
import type { Embedder } from "../discovery/embeddings.js";
import { GATEWAY_VERSION } from "../version.js";
import type { Pool } from "../db/pool.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { DatabaseReadinessProbe } from "./readiness.js";
import type { ChainDeploymentReadinessProbe } from "../payment/deploymentReadiness.js";
import {
  DASKI_X402_SCHEMA_PATH,
  daskiX402Schema,
} from "../payment/x402Extension.js";
import type { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";

export interface MetaRoutesDeps {
  config: Config;
  cache: DiscoveryCache;
  embedder: Embedder | null;
  pool: Pool;
  indexer: ChainEventsIndexer;
  reputationWorker: ReputationMirrorWorker;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  lifecycle: ApplicationLifecycle;
}

function findSkillPath(): string | undefined {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(directory, "../static/SKILL.md"),
    path.resolve(directory, "../../src/static/SKILL.md"),
  ].find((candidate) => fs.existsSync(candidate));
}

function fullDocs(config: Config): string {
  return [
    "# Daski Gateway — full surface",
    "",
    "## Tools (MCP)",
    "",
    "Public:",
    "- daski_search_services — intent-driven provider discovery",
    "- daski_buy_service — validate, quote, and prepare or settle a purchase",
    "- daski_submit_task — dispatch work over A2A",
    "- daski_get_task_status — poll or stream provider task state",
    "- daski_fetch_artifact — retrieve gated task artifacts",
    "- daski_confirm_delivery — submit buyer confirmation",
    "",
    "Identity:",
    "- daski_register_agent — register an ERC-8004 identity",
    "",
    "Resource:",
    "- daski://provider/{agentId} — provider Agent Card and skill metadata",
    "",
    "## HTTP surface",
    "",
    "- POST /purchase/:agentId",
    "- POST /verify, /settle, /confirm/:paymentId, /register-transaction",
    "- GET /register-prep, /confirm-prep/:paymentId, /discover",
    "- GET /.well-known/x402",
    "- GET /public/v1/services, /public/v1/buyers, /public/v1/activity",
    "",
    "## Provider discovery",
    "",
    `- REST catalog: ${config.publicUrl}/discover`,
    "- MCP catalog: daski_search_services",
    "",
    `Network: ${config.network} (chainId ${config.chainId})`,
  ].join("\n");
}

export function createMetaRouter(deps: MetaRoutesDeps): Router {
  const { config, cache, embedder } = deps;
  const router = Router();
  const skillPath = findSkillPath();
  const database = new DatabaseReadinessProbe(deps.pool);

  router.get(["/skill.md", "/SKILL.md", "/.well-known/skill.md"], (_req, res) => {
    if (!skillPath) {
      res.status(500).type("text/plain").send("SKILL.md not bundled");
      return;
    }
    res.type("text/markdown").sendFile(skillPath);
  });

  router.get("/health/live", (_req, res) => {
    res.json({
      status: "alive",
      version: GATEWAY_VERSION,
    });
  });

  router.get("/health/ready", async (_req, res) => {
    const embedderStatus = embedder?.getStatus?.() ?? {
      state: embedder ? ("unknown" as const) : ("disabled" as const),
    };
    const cacheStatus = cache.status();
    const mirrorStatus = deps.reputationWorker.status();
    const databaseReady = await database.isReady();
    const deploymentReady = await deps.deploymentReadiness.isReady();
    const indexerReady = deps.indexer.isFresh();
    const ready =
      !deps.lifecycle.isStopping() &&
      databaseReady &&
      cacheStatus.chainFresh &&
      indexerReady &&
      deploymentReady;
    const degraded =
      embedderStatus.state === "degraded" ||
      cacheStatus.cardFailureCount > 0 ||
      mirrorStatus.lastError !== null;
    res.status(ready ? 200 : 503).json({
      status: ready ? (degraded ? "degraded" : "ready") : "unready",
      version: GATEWAY_VERSION,
      dependencies: {
        chainDeployment: deploymentReady ? "ready" : "unready",
      },
    });
  });

  router.get("/.well-known/mcp.json", (_req, res) => {
    res.json({
      name: "daski-gateway",
      version: GATEWAY_VERSION,
      description:
        "Daski marketplace gateway for provider discovery, x402 settlement, and A2A tasks.",
      transport: {
        type: "streamable-http",
        url: `${config.publicUrl}${config.mcpPath}`,
      },
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
      },
      docs: `${config.publicUrl}/skill.md`,
      chain: { chainId: config.chainId, network: config.network },
    });
  });

  router.get("/.well-known/daski-chain.json", (_req, res) => {
    res.json({
      chainId: config.chainId,
      network: config.network,
      contracts: {
        identityRegistry: config.identityRegistryAddress,
        agentIndex: config.agentIndexAddress,
        providerRegistry: config.providerRegistryAddress,
        serviceRegistry: config.serviceRegistryAddress,
        paymentRouter: config.paymentRouterAddress,
        sanctionsOracle: config.sanctionsOracleAddress,
        sanctionsOracleMode: config.sanctionsOracleMode,
        x402Adapter: config.x402AdapterAddress,
        ...(config.permitAdapterAddress ? { permitAdapter: config.permitAdapterAddress } : {}),
        ...(config.approvalAdapterAddress
          ? { approvalAdapter: config.approvalAdapterAddress }
          : {}),
        ...(config.reputationStorageAddress
          ? { reputationStorage: config.reputationStorageAddress }
          : {}),
        ...(config.reputationRegistryAddress
          ? { reputationRegistry: config.reputationRegistryAddress }
          : {}),
        ...(config.validationRegistryAddress
          ? { validationRegistry: config.validationRegistryAddress }
          : {}),
        usdc: config.usdc.address,
        eas: config.easAddress,
      },
      schemas: {
        easConfirmation: config.easConfirmationSchemaUid,
        easOutcome: config.easOutcomeSchemaUid,
      },
      usdcDomain: config.usdc,
    });
  });

  router.get(DASKI_X402_SCHEMA_PATH, (_req, res) => {
    res.json(daskiX402Schema(config.publicUrl));
  });

  router.get("/.well-known/x402", (_req, res) => {
    // x402scan's compatibility-fallback discovery format: flat resource URL
    // strings plus a guidance string, nothing else. The URLs are the same
    // values the gateway issues as `resource` in payment requirements. Keep
    // this byte-conservative — no Daski extension block.
    const resources = cache
      .getAll()
      .filter(hasMarketplaceService)
      .map(
        (provider) =>
          `${config.publicUrl}/purchase/${provider.agentId.toString()}`,
      );
    res.json({
      version: 2,
      resources,
      instructions:
        `Daski is an agent-to-agent marketplace on ${config.x402Network}. ` +
        `The listed resources are x402 V2 ` +
        `payment-challenge endpoints; opening a challenge requires a JSON ` +
        `body (buyerTokenId, walletAddress, skillId, serviceSlug, ` +
        `providerQuote) — flow documented at ${config.publicUrl}/skill.md. ` +
        `Programmatic discovery and purchase: MCP endpoint ` +
        `${config.publicUrl}${config.mcpPath} (streamable-http); REST ` +
        `catalog ${config.publicUrl}/discover. Facilitator: ` +
        `${config.publicUrl}/supported. Extension schema: ` +
        `${config.publicUrl}${DASKI_X402_SCHEMA_PATH}.`,
    });
  });

  router.get("/llms.txt", (_req, res) => {
    res
      .type("text/markdown")
      .send(
        [
          "# Daski Gateway",
          "",
          "Daski is a decentralized marketplace where agents pay providers in USDC over A2A.",
          "",
          `- MCP endpoint: ${config.publicUrl}${config.mcpPath}`,
          `- Chain descriptor: ${config.publicUrl}/.well-known/daski-chain.json`,
          `- x402 discovery: ${config.publicUrl}/.well-known/x402`,
          `- Skill prompt: ${config.publicUrl}/skill.md`,
          `- Full docs: ${config.publicUrl}/llms-full.txt`,
          `- Network: ${config.network} (chainId ${config.chainId})`,
          "",
        ].join("\n"),
      );
  });

  router.get("/llms-full.txt", (_req, res) => {
    res.type("text/markdown").send(fullDocs(config));
  });
  return router;
}
