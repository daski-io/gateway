import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import { applyDiscoverFilters } from "../discovery/filters.js";
import { formatForSkillDiscover } from "../discovery/skillPresentation.js";
import {
  siblingServiceTypes,
  type CategoryFamily,
  type FulfillmentMode,
  type ServiceType,
} from "../serviceTaxonomy.js";
import type { CachedProvider } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import type { McpDeps } from "./server.js";

export interface SearchServicesArgs {
  intent?: string;
  categoryFamily?: CategoryFamily;
  serviceType?: ServiceType;
  jurisdiction?: string;
  fulfillmentMode?: FulfillmentMode;
  maxPrice?: number;
  limit?: number;
}

interface BestHit {
  distance: number;
  skillId: string;
}

export async function searchServices(
  args: SearchServicesArgs,
  deps: McpDeps,
): Promise<Record<string, unknown>> {
  const limit = args.limit ?? 10;
  const all = deps.cache.getAll();
  const filtered = applyDiscoverFilters(all, args);
  const base = {
    acceptedToken: acceptedToken(deps.config),
    cachedAt: deps.cache.getLastRefresh()?.toISOString() ?? null,
  };
  if (!args.intent?.trim()) {
    const providers = formatForSkillDiscover(filtered, deps.config).slice(
      0,
      limit,
    );
    return {
      ...base,
      providers,
      ...(providers.length === 0
        ? emptyFilterSteer(args, all, deps.config)
        : {}),
    };
  }
  if (!deps.embedder) {
    return {
      ...base,
      providers: formatForSkillDiscover(filtered, deps.config).slice(0, limit),
      note: "embedder disabled — returning unranked catalog",
    };
  }

  let hits: Awaited<ReturnType<Queries["searchSkillsByEmbedding"]>>;
  try {
    await deps.embeddingSync?.waitForIdle();
    const vector = await deps.embedder.embed(args.intent);
    hits = await deps.queries.searchSkillsByEmbedding(
      vector,
      Math.min(limit * 5, 250),
    );
  } catch (error) {
    return {
      ...base,
      intent: args.intent,
      providers: formatForSkillDiscover(filtered, deps.config).slice(0, limit),
      ranking: "unavailable",
      warning:
        "Intent ranking is temporarily unavailable; returning the filtered catalog.",
      correlationId: logErrorWithId(
        "daski_search_services.embedding",
        error,
      ),
    };
  }

  const bestByCard = new Map<string, BestHit>();
  const allBestByCard = new Map<string, BestHit>();
  const eligibleSkills = args.fulfillmentMode
    ? eligibleSkillKeys(filtered, args.fulfillmentMode, deps.config)
    : null;
  for (const hit of hits) {
    const key = `${hit.providerAgentId}:${hit.serviceSlug}`;
    recordBestHit(allBestByCard, key, hit);
    if (eligibleSkills && !eligibleSkills.has(`${key}:${hit.skillId}`)) {
      continue;
    }
    recordBestHit(bestByCard, key, hit);
  }

  const entries = entryIndex(filtered, deps.config);
  const matches = [...bestByCard.entries()]
    .filter(([key]) => entries.has(key))
    .sort((left, right) => left[1].distance - right[1].distance)
    .slice(0, limit)
    .map(([key, hit]) => ({
      ...entries.get(key)!,
      match: {
        distance: hit.distance,
        bestSkillId: hit.skillId,
      },
    }));
  const nearMisses =
    matches.length === 0
      ? nearMissesFor(allBestByCard, all, limit, deps.config)
      : [];
  return {
    ...base,
    intent: args.intent,
    providers: matches,
    ranking: "vector",
    ...(nearMisses.length > 0 ? { nearMisses } : {}),
  };
}

/**
 * A structured filter matched nothing. Every taxonomy slug is a legal filter
 * value, so an empty list is not evidence the agent guessed wrong — without a
 * steer it re-guesses blind. Name the sibling service types that DO have
 * supply under the same remaining filters, and fall back to `intent`.
 */
function emptyFilterSteer(
  args: SearchServicesArgs,
  all: CachedProvider[],
  config: Config,
): Record<string, unknown> {
  if (!args.serviceType) {
    return {
      hint:
        "No provider matched these filters. Drop the narrowest filter, or " +
        "pass `intent` with a free-text description to let the catalog rank " +
        "the closest services.",
    };
  }
  const siblings = siblingServiceTypes(args.serviceType);
  const stocked = siblings.filter(
    (candidate) =>
      formatForSkillDiscover(
        applyDiscoverFilters(all, { ...args, serviceType: candidate }),
        config,
      ).length > 0,
  );
  return {
    hint:
      `'${args.serviceType}' is a valid service type but no provider ` +
      "currently lists under it" +
      (stocked.length > 0
        ? `. These service types in the same family have providers: ${stocked.join(", ")}.`
        : " or under any sibling service type in its family.") +
      " Or pass `intent` with a free-text description to rank the closest " +
      "services.",
    ...(stocked.length > 0 ? { availableServiceTypes: stocked } : {}),
  };
}

function acceptedToken(config: Config): Record<string, unknown> {
  return {
    address: config.usdcAddress,
    name: config.usdcName,
    version: config.usdcVersion,
    chainId: config.chainId,
    network: config.network,
  };
}

function entryIndex(
  providers: CachedProvider[],
  config: Config,
): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const entry of formatForSkillDiscover(providers, config)) {
    const slug = (entry.serviceSlug as string | null) ?? "";
    index.set(`${entry.agentId as string}:${slug}`, entry);
  }
  return index;
}

function eligibleSkillKeys(
  providers: CachedProvider[],
  fulfillmentMode: FulfillmentMode,
  config: Config,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of formatForSkillDiscover(providers, config)) {
    const cardKey = `${entry.agentId as string}:${
      (entry.serviceSlug as string | null) ?? ""
    }`;
    const skills = Array.isArray(entry.skills) ? entry.skills : [];
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const record = skill as Record<string, unknown>;
      if (
        typeof record.id === "string" &&
        record.fulfillmentMode === fulfillmentMode
      ) {
        keys.add(`${cardKey}:${record.id}`);
      }
    }
  }
  return keys;
}

function recordBestHit(
  target: Map<string, BestHit>,
  key: string,
  hit: BestHit,
): void {
  const current = target.get(key);
  if (!current || hit.distance < current.distance) {
    target.set(key, hit);
  }
}

function nearMissesFor(
  hits: Map<string, BestHit>,
  providers: CachedProvider[],
  limit: number,
  config: Config,
): Array<Record<string, unknown>> {
  const entries = entryIndex(providers, config);
  return [...hits.entries()]
    .filter(([key]) => entries.has(key))
    .sort((left, right) => left[1].distance - right[1].distance)
    .slice(0, Math.min(limit, 3))
    .map(([key, hit]) => ({
      ...entries.get(key)!,
      match: {
        distance: hit.distance,
        bestSkillId: hit.skillId,
      },
    }));
}
