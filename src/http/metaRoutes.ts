import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Embedder } from "../discovery/embeddings.js";
import { cardsOf } from "../discovery/format.js";
import { GATEWAY_VERSION } from "../version.js";
import { buildX402Catalog } from "./x402Catalog.js";

export interface MetaRoutesDeps {
  config: Config;
  cache: DiscoveryCache;
  embedder: Embedder | null;
}

function findSkillPath(): string | undefined {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(directory, "../static/SKILL.md"),
    path.resolve(directory, "../../src/static/SKILL.md"),
  ].find((candidate) => fs.existsSync(candidate));
}

function fullDocs(config: Config, cache: DiscoveryCache): string {
  const providers = cache
    .getAll()
    .map((provider) => {
      const names = cardsOf(provider)
        .map((card) => (card.agentCard as { name?: string }).name ?? "(unnamed)")
        .join(" + ");
      return `- agentId ${provider.agentId.toString()}: ${names || "(unnamed)"}`;
    })
    .join("\n");
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
    "- GET/POST /x402/services/:agentId/:serviceSlug/:skillId",
    "- POST /verify, /settle, /confirm/:paymentId, /register",
    "- GET /register-prep, /confirm-prep/:paymentId, /discover",
    "- GET /public/v1/services, /public/v1/buyers, /public/v1/activity",
    "",
    "## Providers (live)",
    "",
    providers || "(none in cache)",
    "",
    `Network: ${config.network} (chainId ${config.chainId})`,
  ].join("\n");
}

export function createMetaRouter(deps: MetaRoutesDeps): Router {
  const { config, cache, embedder } = deps;
  const router = Router();
  const skillPath = findSkillPath();

  router.get(["/skill.md", "/SKILL.md", "/.well-known/skill.md"], (_req, res) => {
    if (!skillPath) {
      res.status(500).type("text/plain").send("SKILL.md not bundled");
      return;
    }
    res.type("text/markdown").sendFile(skillPath);
  });

  router.get("/health", (_req, res) => {
    const embedderStatus = embedder?.getStatus?.() ?? {
      state: embedder ? ("unknown" as const) : ("disabled" as const),
    };
    res.json({
      status: embedderStatus.state === "degraded" ? "degraded" : "ok",
      version: GATEWAY_VERSION,
      chain: { chainId: config.chainId, network: config.network },
      cache: {
        providers: cache.getAll().length,
        lastRefresh: cache.getLastRefresh()?.toISOString() ?? null,
      },
      embedder: embedderStatus,
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
        ...(config.directAdapterAddress ? { directAdapter: config.directAdapterAddress } : {}),
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

  router.get("/.well-known/x402-services.json", (_req, res) => {
    res.json({
      x402Version: 1,
      services: buildX402Catalog(config, cache),
      generatedAt: new Date().toISOString(),
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
          `- x402 services: ${config.publicUrl}/.well-known/x402-services.json`,
          `- Chain descriptor: ${config.publicUrl}/.well-known/daski-chain.json`,
          `- Skill prompt: ${config.publicUrl}/skill.md`,
          `- Full docs: ${config.publicUrl}/llms-full.txt`,
          `- Network: ${config.network} (chainId ${config.chainId})`,
          "",
        ].join("\n"),
      );
  });

  router.get("/llms-full.txt", (_req, res) => {
    res.type("text/markdown").send(fullDocs(config, cache));
  });
  return router;
}
