import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { a2aPostJson, providerErrorFromFailure, type Fetcher } from "./a2a.js";
import type { BuyServiceContext } from "./buyServiceTypes.js";
import { requireFreshCatalogMatch } from "./freshProvider.js";
import { findCatalogSkillAtA2AEndpoint } from "./providerCatalog.js";
import { sanitizeProviderValue } from "./providerReflection.js";
import { unknownServiceArgWarnings } from "./serviceArgWarnings.js";
import {
  mcpError,
  mcpJson,
  type McpToolResult,
} from "./util.js";

interface FreePathDeps {
  config: Config;
  cache: DiscoveryCache;
  providerAuthority: ProviderAuthorityService;
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}
function synchronousDispatch(
  skillMeta: Record<string, unknown>,
): { endpoint: string; kind: string } | null {
  const endpoint = skillMeta.directEndpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("/")) return null;
  const kind =
    typeof skillMeta.directResultKind === "string"
      ? skillMeta.directResultKind
      : "direct";
  return { endpoint, kind };
}

async function runSynchronousFreeSkill(
  ctx: BuyServiceContext,
  endpoint: string,
  responseKind: string,
  deps: FreePathDeps,
): Promise<McpToolResult> {
  const targetUrl = ctx.providerA2AUrl.replace(/\/a2a(?=\/|$)/, endpoint);
  const post = await a2aPostJson<Record<string, unknown>>(
    targetUrl,
    ctx.serviceArgs,
    {
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      maxBytes: deps.maxResponseBytes,
    },
  );
  if (!post.ok) return providerErrorFromFailure(post, targetUrl);
  const body = sanitizeProviderValue(post.body);
  if (!post.raw.ok) {
    return mcpError({
      code: "PROVIDER_ERROR",
      message: `${ctx.args.skillId} provider returned HTTP ${post.status}.`,
      details: {
        untrustedProviderContent: body,
      },
    });
  }
  return mcpJson({
    status: "completed",
    kind: responseKind,
    providerTokenId: ctx.provider.agentId.toString(),
    providerA2AUrl: ctx.providerA2AUrl,
    skillId: ctx.args.skillId,
    chainId: deps.config.chainId,
    untrustedProviderContent: body,
    network: deps.config.network,
    plan: { steps: [] },
  });
}

function buildFreeSkillPlan(
  ctx: BuyServiceContext,
  flags: {
    isOpenFree: boolean;
    requiresCapability: boolean;
    requiresAssetOwnership: boolean;
  },
  config: Config,
): McpToolResult {
  const { args, provider, providerA2AUrl, serviceArgs } = ctx;
  const { isOpenFree, requiresCapability, requiresAssetOwnership } = flags;
  const steps: Array<{ toolName: string; hint: string; args: unknown }> = [];

  if (!isOpenFree) {
    steps.push({
      toolName: "daski_submit_task",
      hint:
        "First call: omit envelopeAuth to receive typed data and a messageId.",
      args: {
        providerA2AUrl,
        skillId: args.skillId,
        paymentId: args.paymentId ?? "0",
        chainId: config.chainId,
        buyerTokenId: args.buyerTokenId,
        serviceArgs,
      },
    });
  }
  steps.push({
    toolName: isOpenFree ? "daski_submit_task" : "<your-wallet>.signTypedData",
    hint: isOpenFree
      ? "Dispatch directly. The synchronous result is returned inline."
      : "Sign the typed data returned by daski_submit_task.",
    args: isOpenFree
      ? {
          providerA2AUrl,
          skillId: args.skillId,
          ...(args.paymentId ? { paymentId: args.paymentId } : {}),
          chainId: config.chainId,
          serviceArgs,
        }
      : { typedData: "<from previous daski_submit_task.eip712TypedData>" },
  });
  if (!isOpenFree) {
    steps.push({
      toolName: "daski_submit_task",
      hint: requiresCapability
        ? "Submit the signed envelope to receive the provider-issued capability challenge and a fresh execute envelope."
        : "Submit the signed envelope with the same messageId.",
      args: {
        providerA2AUrl,
        skillId: args.skillId,
        paymentId: args.paymentId ?? "0",
        chainId: config.chainId,
        serviceArgs,
        messageId: "<from first daski_submit_task call>",
        envelopeAuth: "<signed envelope>",
      },
    });
  }
  if (requiresCapability) {
    steps.push(
      {
        toolName: "<your-wallet>.signTypedData",
        hint:
          "Sign both the provider capability and nextEnvelopeAuthChallenge.",
        args: { typedData: "<both typed-data payloads>" },
      },
      {
        toolName: "daski_submit_task",
        hint:
          "Execute with the capability, fresh envelope, messageId, and contextId.",
        args: {
          providerA2AUrl,
          skillId: args.skillId,
          paymentId: args.paymentId ?? "0",
          chainId: config.chainId,
          serviceArgs,
          messageId: "<from nextEnvelopeAuthChallenge>",
          envelopeAuth: "<signed fresh envelope>",
          capability: "<signed capability>",
          contextId: "<from capability challenge>",
        },
      },
    );
  }
  if (!isOpenFree) {
    steps.push({
      toolName: "daski_get_task_status",
      hint: "Poll until status is completed or failed.",
      args: { providerA2AUrl, taskId: "<from daski_submit_task>" },
    });
  }

  const warnings = unknownServiceArgWarnings(
    provider.skillMeta,
    args.serviceArgs,
  );
  return mcpJson({
    status: "action-required",
    action: "submit_task",
    kind: "free",
    freeKind: isOpenFree ? "open" : "ownership-gated",
    providerTokenId: provider.agentId.toString(),
    providerA2AUrl,
    skillId: args.skillId,
    paymentId: args.paymentId ?? null,
    requiresCapability,
    requiresAssetOwnership,
    chainId: config.chainId,
    network: config.network,
    ...(warnings.length > 0 ? { warnings } : {}),
    plan: { steps },
  });
}

export async function runBuyServiceFreePath(
  ctx: BuyServiceContext,
  deps: FreePathDeps,
): Promise<McpToolResult> {
  const fresh = await requireFreshCatalogMatch(
    ctx.provider.agentId,
    deps.providerAuthority,
    () => {
      const endpoint = findCatalogSkillAtA2AEndpoint(
        deps.cache, ctx.providerA2AUrl, ctx.args.skillId,
      );
      return endpoint?.card.serviceSlug === ctx.provider.serviceSlug
        ? endpoint
        : null;
    },
  );
  if (!fresh.ok) return fresh.result;
  const provider = {
    agentId: fresh.endpoint.provider.agentId,
    serviceSlug: fresh.endpoint.card.serviceSlug,
    skillMeta: fresh.endpoint.skillMeta,
    agentCard: fresh.endpoint.card.agentCard,
  };
  ctx = { ...ctx, provider, providerA2AUrl: fresh.endpoint.url };
  const requiresAssetOwnership =
    ctx.provider.skillMeta.requiresAssetOwnership === true;
  const requiresCapability =
    ctx.provider.skillMeta.requiresCapability === true;
  const isOpenFree = !requiresAssetOwnership && !requiresCapability;

  if (isOpenFree) {
    const direct = synchronousDispatch(ctx.provider.skillMeta);
    if (direct) {
      return runSynchronousFreeSkill(ctx, direct.endpoint, direct.kind, deps);
    }
  } else {
    if (ctx.buyerAgentId === 0n) {
      return mcpError({
        code: "buyer_not_registered",
        message:
          "Ownership-gated free skills require a registered buyer wallet.",
      });
    }
    if (!ctx.args.paymentId) {
      return mcpError({
        code: "payment_id_required",
        message:
          `Skill '${ctx.args.skillId}' requires the original asset ` +
          "purchase paymentId.",
      });
    }
  }

  return buildFreeSkillPlan(
    ctx,
    { isOpenFree, requiresCapability, requiresAssetOwnership },
    deps.config,
  );
}
