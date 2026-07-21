import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Embedder } from "../discovery/embeddings.js";
import { GATEWAY_VERSION } from "../version.js";
import type { Pool } from "../db/pool.js";
import type { ChainEventsIndexer } from "../indexer/chainEvents.js";
import type { ReputationMirrorWorker } from "../reputation/worker.js";
import { DatabaseReadinessProbe } from "./readiness.js";
import type { PaymentScreeningReadinessProbe } from "../payment/screeningReadiness.js";

export interface MetaRoutesDeps {
  config: Config;
  cache: DiscoveryCache;
  embedder: Embedder | null;
  pool: Pool;
  indexer: ChainEventsIndexer;
  reputationWorker: ReputationMirrorWorker;
  screeningReadiness: PaymentScreeningReadinessProbe;
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
    "Advanced:",
    "- daski_register_agent — register an ERC-8004 identity",
    "- daski_purchase — open a payment challenge",
    "- daski_settle_payment — settle a signed x402 payload",
    "",
    "Resource:",
    "- daski://provider/{agentId} — provider Agent Card and skill metadata",
    "",
    "## HTTP surface",
    "",
    "- POST /purchase/:agentId",
    "- POST /verify, /settle, /confirm/:paymentId, /register-transaction",
    "- GET /register-prep, /confirm-prep/:paymentId, /discover",
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
    const screeningReady = await deps.screeningReadiness.isReady();
    const indexerReady = deps.indexer.isFresh();
    const ready =
      databaseReady && cacheStatus.chainFresh && indexerReady && screeningReady;
    const degraded =
      embedderStatus.state === "degraded" ||
      cacheStatus.cardFailureCount > 0 ||
      mirrorStatus.lastError !== null;
    res.status(ready ? 200 : 503).json({
      status: ready ? (degraded ? "degraded" : "ready") : "unready",
      version: GATEWAY_VERSION,
      dependencies: {
        paymentScreening: screeningReady ? "ready" : "unready",
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
        usdc: config.usdcAddress,
        eas: config.easAddress,
      },
      schemas: {
        easConfirmation: config.easConfirmationSchemaUid,
        easOutcome: config.easOutcomeSchemaUid,
      },
      usdcDomain: { name: config.usdcName, version: config.usdcVersion },
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
