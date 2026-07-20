import type { DiscoveryCache } from "../discovery/cache.js";
import type { BuyServiceArgs } from "./buyServiceTypes.js";
import {
  findProvidersOfferingSkill,
  type ProviderMatch,
} from "./providerCatalog.js";
import {
  mcpError,
  parseBigIntArg,
  type McpToolResult,
} from "./util.js";

type ProviderResult =
  | { ok: true; provider: ProviderMatch }
  | { ok: false; error: McpToolResult };

export function resolveBuyServiceProvider(
  args: BuyServiceArgs,
  cache: DiscoveryCache,
): ProviderResult {
  const matches = findProvidersOfferingSkill(
    cache,
    args.skillId,
    args.serviceSlug,
  );
  if (args.providerTokenId) {
    const parsed = parseBigIntArg(args.providerTokenId, "providerTokenId");
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const provider = matches.find((match) => match.agentId === parsed.value);
    return provider
      ? { ok: true, provider }
      : {
          ok: false,
          error: mcpError({
            code: "skill_not_offered_by_provider",
            message:
              `provider ${args.providerTokenId} does not offer skill ` +
              `'${args.skillId}'`,
          }),
        };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      error: mcpError({
        code: "skill_not_found",
        message: `no whitelisted provider offers skill '${args.skillId}'`,
      }),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: mcpError({
        code: "ambiguous_provider",
        message: `multiple providers offer skill '${args.skillId}'`,
        details: {
          providerTokenIds: matches.map((match) => match.agentId.toString()),
        },
      }),
    };
  }
  return { ok: true, provider: matches[0]! };
}
