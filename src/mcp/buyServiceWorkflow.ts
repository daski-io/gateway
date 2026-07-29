import { extractAgentCardUrl } from "../discovery/agentCard.js";
import { walletControlsAgent } from "../identity/control.js";
import { sanitizeBuyerName } from "../identity/name.js";
import type { Hex } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import { isHexAddress } from "../util/evmValidation.js";
import type { Fetcher } from "./a2a.js";
import { runBuyServiceFreePath } from "./buyServiceFree.js";
import { runBuyServicePaidPath } from "./buyServicePaid.js";
import { resolveBuyServiceProvider } from "./buyServiceProvider.js";
import { runBuyServiceX402Retry } from "./buyServiceRetry.js";
import type { BuyServiceArgs, BuyServiceContext } from "./buyServiceTypes.js";
import type { McpDeps } from "./server.js";
import {
  checkPhoneFields,
  mcpError,
  parseBigIntArg,
  validateAndNormalizeServiceArgs,
  type McpToolResult,
} from "./util.js";

interface BuyServiceTransport {
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

export async function runBuyService(
  args: BuyServiceArgs,
  extra: { _meta?: Record<string, unknown> },
  deps: McpDeps,
  transport: BuyServiceTransport,
): Promise<McpToolResult> {
  if (!isHexAddress(args.walletAddress)) {
    return mcpError({
      code: "BAD_INPUT",
      message: "walletAddress must be a 20-byte hex address",
    });
  }

  const retry = await runBuyServiceX402Retry(args, extra, {
    queries: deps.queries,
    deploymentReadiness: deps.deploymentReadiness,
    facilitator: deps.facilitator,
  });
  if (retry !== null) return retry;

  let buyerName: string | undefined;
  if (args.name != null && args.name !== "") {
    if (args.useWalletDerivedName === true) {
      return mcpError({
        code: "BAD_INPUT",
        message:
          "Pass exactly ONE of `name` (the principal's exact stated " +
          "business/entity name) or `useWalletDerivedName: true` — they " +
          "are mutually exclusive identity choices.",
        recoverable: true,
        next_action: "Drop one of the two fields and re-send.",
      });
    }
    const sanitized = sanitizeBuyerName(args.name);
    if (!sanitized.ok) {
      return mcpError({
        code: "BAD_INPUT",
        message: `name: ${sanitized.error}`,
        recoverable: true,
        next_action:
          "Fix name, or pass useWalletDerivedName: true to accept the " +
          "wallet-derived default explicitly.",
      });
    }
    buyerName = sanitized.name;
  }

  const lookup = resolveBuyServiceProvider(args, deps.cache);
  if (!lookup.ok) return lookup.error;
  const provider = lookup.provider;
  const requiredFields = Array.isArray(provider.skillMeta.requiredFields)
    ? (provider.skillMeta.requiredFields as string[])
    : [];
  const validated = validateAndNormalizeServiceArgs(
    args.serviceArgs,
    requiredFields,
  );
  if (!validated.ok) return validated.error;
  const serviceArgs = validated.args;

  const phoneError = checkPhoneFields(serviceArgs);
  if (phoneError) return phoneError;

  let parsedBuyerTokenId: bigint | null = null;
  if (args.buyerTokenId) {
    const parsed = parseBigIntArg(args.buyerTokenId, "buyerTokenId");
    if (!parsed.ok) return parsed.error;
    parsedBuyerTokenId = parsed.value;
  }

  let buyerAgentId: bigint;
  if (parsedBuyerTokenId !== null && parsedBuyerTokenId !== 0n) {
    buyerAgentId = parsedBuyerTokenId;
  } else {
    try {
      buyerAgentId = await deps.reader.agentOfWallet(
        args.walletAddress.toLowerCase() as Hex,
      );
    } catch (error) {
      return mcpError({
        code: "CHAIN_READ_FAILED",
        message: publicErrorMessage(
          "mcp.buyService.agentOfWallet",
          error,
          "buyer identity lookup failed",
        ),
      });
    }
  }

  if (!deps.cache.get(provider.agentId)) {
    return mcpError({
      code: "provider_not_found",
      message: "provider is not currently admitted",
    });
  }
  const providerA2AUrl = extractAgentCardUrl(provider.agentCard);
  if (!providerA2AUrl) {
    return mcpError({
      code: "pricing_unavailable",
      message: "provider agent card is missing url",
    });
  }

  const context: BuyServiceContext = {
    args,
    provider,
    providerA2AUrl,
    serviceArgs,
    buyerAgentId,
    buyerName,
  };
  const paymentRequired = provider.skillMeta.paymentRequired !== false;
  if (
    !paymentRequired &&
    parsedBuyerTokenId !== null &&
    parsedBuyerTokenId !== 0n &&
    !(await walletControlsAgent(
      deps.reader,
      parsedBuyerTokenId,
      args.walletAddress.toLowerCase() as Hex,
    ))
  ) {
    return mcpError({
      code: "buyer_agent_not_controlled",
      message: "walletAddress does not control the supplied buyerTokenId",
    });
  }

  return paymentRequired
    ? runBuyServicePaidPath(context, {
        config: deps.config,
        cache: deps.cache,
        queries: deps.queries,
        reader: deps.reader,
        fetch: transport.fetch,
        timeoutMs: transport.timeoutMs,
        maxResponseBytes: transport.maxResponseBytes,
        fetchAgentCardFn: deps.buyerAgentCardFetch,
        deploymentReadiness: deps.deploymentReadiness,
      })
    : runBuyServiceFreePath(context, {
        config: deps.config,
        fetch: transport.fetch,
        timeoutMs: transport.timeoutMs,
        maxResponseBytes: transport.maxResponseBytes,
      });
}
