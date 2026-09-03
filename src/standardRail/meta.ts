import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { ApplicationLifecycle } from "../runtime/applicationLifecycle.js";
import { GATEWAY_COMMIT, GATEWAY_VERSION } from "../version.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardRailService } from "./service.js";
import type { PublicChainMetadataV3 } from "./types.js";
import { llmsFull, llmsIndex, readSkill, skillIndex, legacySkillIndex } from "./skills.js";
import {
  ACTIVITY_MAX_LIMIT,
  activityLimit,
  activityProjection,
} from "./activityProjection.js";

// Public projections are refreshed in the background, so a short shared
// cache costs consumers nothing in freshness and lets browsers, the website,
// and any CDN revalidate cheaply against the ETag express derives.
const PUBLIC_PROJECTION_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=300";
/** When the reputation projection behind the response was last refreshed. */
export const PROJECTION_REFRESHED_AT_HEADER = "DASKI-PROJECTION-REFRESHED-AT";

function publicProjectionHeaders(res: Response, refreshedAt: Date | null): void {
  res.setHeader("Cache-Control", PUBLIC_PROJECTION_CACHE_CONTROL);
  res.vary("Accept-Encoding");
  if (refreshedAt) res.setHeader(PROJECTION_REFRESHED_AT_HEADER, refreshedAt.toISOString());
}

function operatorAuthorized(req: Request, token: string | null): boolean {
  if (!token) return false;
  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length).trim(), "utf8");
  const wanted = Buffer.from(token, "utf8");
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

const PUBLIC_RELAYER_FIELDS = new Set(["chainId", "address"]);

function publicOperations(
  observed: Record<string, unknown>,
): Record<string, unknown> {
  const reputation = observed.reputation;
  if (!reputation || typeof reputation !== "object") return observed;
  const { relayer, ...counters } = reputation as Record<string, unknown>;
  const publicRelayer = relayer && typeof relayer === "object"
    ? Object.fromEntries(Object.entries(relayer as Record<string, unknown>)
      .filter(([key]) => PUBLIC_RELAYER_FIELDS.has(key)))
    : null;
  return { ...observed, reputation: { ...counters, relayer: publicRelayer } };
}

function chainContracts(args: {
  config: Config;
  railConfig: StandardRailConfig;
}): PublicChainMetadataV3["contracts"] {
  return {
    identityRegistry: args.config.marketplaceContracts.identityRegistry,
    agentIndex: args.config.marketplaceContracts.agentIndex,
    providerRegistry: args.config.marketplaceContracts.providerRegistry,
    serviceRegistry: args.config.marketplaceContracts.serviceRegistry,
    validationRegistry: args.config.marketplaceContracts.validationRegistry,
    reputationStorage: args.config.marketplaceContracts.reputationStorage,
    eas: args.railConfig.easAddress,
    usdc: args.config.usdc.address,
  };
}

export function createStandardMetaRouter(args: {
  config: Config;
  pool: Pool;
  lifecycle: ApplicationLifecycle;
  service: StandardRailService;
  railConfig: StandardRailConfig;
}): Router {
  const router = Router();
  router.get("/health/live", (_req, res) => {
    res.json({ status: "alive", version: GATEWAY_VERSION, commit: GATEWAY_COMMIT });
  });
  router.get("/health/ready", async (req, res) => {
    const databaseReady = await args.pool.query("SELECT 1").then(() => true, () => false);
    const admissionOpen = args.service.isAdmissionOpen();
    const dependenciesReady = args.service.areDependenciesReady();
    const observed = databaseReady ? await args.service.operationalHealth().catch(() => null) : null;
    // Relayer balance and nonces stay with the operator: on the public
    // surface they let anyone time a sponsorship drain or spot under-funding.
    const operations = observed === null
      ? null
      : operatorAuthorized(req, args.config.catalogOperatorToken)
        ? observed
        : publicOperations(observed);
    const ready = databaseReady && admissionOpen && dependenciesReady && !args.lifecycle.isStopping();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unready",
      version: GATEWAY_VERSION,
      commit: GATEWAY_COMMIT,
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
    try {
      const metadata: PublicChainMetadataV3 = {
        version: 3,
        outcomeSchemaVersion: 1,
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
        contracts: chainContracts(args),
        outcomes: await args.service.publicOutcomes(),
      };
      publicProjectionHeaders(res, args.service.publicProjectionRefreshedAt());
      res.json(metadata);
    } catch (error) { next(error); }
  });
  // The rows the marketplace activity page renders, without the per-outcome
  // reputation blocks the chain document repeats: same projection, same
  // caching, a fraction of the bytes.
  router.get("/public/v3/activity", async (req, res, next) => {
    try {
      const limit = activityLimit(req.query.limit);
      if (limit === null) {
        res.status(400).json({
          error: {
            code: "INVALID_LIMIT",
            message: `limit must be an integer from 1 to ${ACTIVITY_MAX_LIMIT}.`,
          },
        });
        return;
      }
      const refreshedAt = args.service.publicProjectionRefreshedAt();
      const projection = activityProjection({
        outcomes: await args.service.publicOutcomes(),
        network: args.config.network,
        chainId: args.config.chainId,
        contracts: chainContracts(args),
        generatedAt: refreshedAt ?? new Date(),
        limit,
      });
      publicProjectionHeaders(res, refreshedAt);
      res.json(projection);
    } catch (error) { next(error); }
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
        "daski_get_payment_challenge",
        "daski_get_setup_guide",
        "daski_list_my_orders",
        "daski_get_my_reputation",
        "daski_list_assets",
        "daski_use_asset",
        "daski_get_order_access",
        "daski_get_order_status",
        "daski_submit_order_input",
        "daski_cancel_order",
        "daski_get_order_artifact",
        "daski_contact_order_support",
        "daski_confirm_delivery",
        "daski_revoke_delivery_confirmation",
      ],
      skills: {
        setup: `${args.config.publicUrl}/skills/setup.md`,
        buy: `${args.config.publicUrl}/skills/buy.md`,
        orders: `${args.config.publicUrl}/skills/orders.md`,
        wallets: `${args.config.publicUrl}/skills/wallets.md`,
        recipe: `${args.config.publicUrl}/skills/recipe.md`,
        installable: `${args.config.publicUrl}/skills/SKILL.md`,
      },
      steadyStatePrompt: "Use Daski to [your task].",
    });
  });
  router.get("/.well-known/agent-skills/index.json", async (_req, res, next) => {
    try {
      res.json(await skillIndex(args.config.publicUrl, GATEWAY_VERSION));
    } catch (error) { next(error); }
  });
  router.get("/.well-known/skills/index.json", async (_req, res, next) => {
    try {
      res.json(await legacySkillIndex());
    } catch (error) { next(error); }
  });
  router.get("/.well-known/skills/daski/SKILL.md", async (_req, res, next) => {
    try {
      res.type("text/markdown").send((await readSkill("daski")).content);
    } catch (error) { next(error); }
  });
  router.get("/skills/:file", async (req, res, next) => {
    try {
      const file = String(req.params.file);
      const topic = file === "SKILL.md" ? "daski"
        : file.endsWith(".md") ? file.slice(0, -3) : "";
      if (!["setup", "buy", "orders", "wallets", "recipe", "daski"].includes(topic)) {
        res.status(404).send("Skill not found");
        return;
      }
      const skill = await readSkill(topic as Parameters<typeof readSkill>[0]);
      res.type("text/markdown").send(skill.content);
    } catch (error) { next(error); }
  });
  router.get("/llms.txt", (_req, res) => {
    res.type("text/markdown").send(llmsIndex(args.config.publicUrl, args.config.mcpPath));
  });
  router.get("/llms-full.txt", async (_req, res, next) => {
    try {
      res.type("text/markdown").send(await llmsFull());
    } catch (error) { next(error); }
  });
  router.get(["/skill.md", "/SKILL.md"], async (_req, res, next) => {
    try {
      res.type("text/markdown").send((await readSkill("daski")).content);
    } catch (error) { next(error); }
  });
  return router;
}
