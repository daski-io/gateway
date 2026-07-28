import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import {
  buildRegistrationTransaction,
  prepareRegistration,
} from "../identity/service.js";
import { createQuotedChallenge } from "../payment/quotedChallenge.js";
import type { Hex } from "../types.js";
import { hashCanonical } from "../payment/requirementResponse.js";
import type { Fetcher } from "./a2a.js";
import type { PaymentScreeningReadinessProbe } from "../payment/screeningReadiness.js";
import type { BuyServiceContext } from "./buyServiceTypes.js";
import { unknownServiceArgWarnings } from "./serviceArgWarnings.js";
import { logger } from "../util/logger.js";
import {
  buyerNameMismatchWarning,
  mcpError,
  phoneWhoisWarnings,
  type McpToolResult,
} from "./util.js";

interface PaidPathDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
  screeningReadiness: PaymentScreeningReadinessProbe;
}

export async function runBuyServicePaidPath(
  ctx: BuyServiceContext,
  deps: PaidPathDeps,
): Promise<McpToolResult> {
  const { args, provider, serviceArgs, buyerAgentId, buyerName } = ctx;
  const isAtomic = buyerAgentId === 0n;
  if (isAtomic && !args.registration) {
    const prepared = await prepareRegistration(
      {
        config: deps.config,
        reader: deps.reader,
        fetchAgentCardFn: deps.fetchAgentCardFn,
      },
      {
        walletAddress: args.walletAddress,
        name: buyerName,
        deadlineSeconds: 3600,
      },
    );
    if (!prepared.ok) {
      return mcpError(prepared.error);
    }
    return mcpError({
      code: "registration_required",
      message:
        "Register-and-settle requires a signed registration delegation before payment is requested.",
      recoverable: true,
      next_action:
        "Sign details.registrationPrep.eip712TypedData, then retry this tool call with registration.",
      details: { registrationPrep: prepared.value },
    });
  }
  if (isAtomic && args.registration) {
    const validated = await buildRegistrationTransaction(
      {
        config: deps.config,
        reader: deps.reader,
        fetchAgentCardFn: deps.fetchAgentCardFn,
      },
      {
        walletAddress: args.walletAddress,
        ...args.registration,
      },
    );
    if (!validated.ok) return mcpError(validated.error);
  }
  const result = await createQuotedChallenge(
    {
      providerAgentId: provider.agentId,
      buyerAgentId,
      walletAddress: args.walletAddress.toLowerCase() as Hex,
      skillId: args.skillId,
      serviceSlug: args.serviceSlug,
      serviceArgs,
      amountLimit: args.amount,
      requestFingerprint: hashCanonical(args),
      registrationDelegation: args.registration
        ? {
            ...args.registration,
            signature: args.registration.signature as Hex,
          }
        : undefined,
    },
    {
      config: deps.config,
      cache: deps.cache,
      queries: deps.queries,
      reader: deps.reader,
      fetch: deps.fetch,
      timeoutMs: deps.timeoutMs,
      maxResponseBytes: deps.maxResponseBytes,
      screeningReadiness: deps.screeningReadiness,
    },
  );
  if (!result.ok) {
    const warnings =
      result.error.code === "quote_validation_failed"
        ? unknownServiceArgWarnings(provider.skillMeta, args.serviceArgs)
        : [];
    return mcpError({
      code: result.error.code,
      message:
        warnings.length > 0
          ? `${warnings.join(" ")} ${result.error.message}`
          : result.error.message,
      details: {
        ...(result.error.details ?? {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      recoverable: result.error.recoverable,
      next_action: result.error.nextAction,
    });
  }

  const requirements = result.value.requirements;
  // Flow snapshot (migration 017): persist the canonical serviceArgs the
  // quote committed to plus the acknowledgements captured on this call,
  // so continuation calls can omit re-entry and acknowledgements survive
  // restarts. Best-effort — never fails the purchase.
  try {
    await deps.queries.recordFlowState(
      result.value.challenge.serviceRef,
      serviceArgs,
      {
        ...(buyerName
          ? { buyerName }
          : args.useWalletDerivedName
            ? { buyerName: "wallet-derived" }
            : {}),
      },
    );
  } catch {
    // snapshot only
  }
  const warnings = unknownServiceArgWarnings(
    provider.skillMeta,
    args.serviceArgs,
  );
  warnings.push(...phoneWhoisWarnings(serviceArgs));
  if (isAtomic && args.useWalletDerivedName !== true) {
    // The identity minted with this purchase is permanent — surface a
    // divergence from the request's own companyName while it can still be
    // corrected. A warning, never a gate: mismatches can be deliberate.
    const mismatch = buyerNameMismatchWarning(buyerName ?? null, serviceArgs);
    if (mismatch) warnings.push(mismatch);
  }
  if (!isAtomic && buyerName) {
    warnings.push(
      `\`name\` was ignored because agentId ${buyerAgentId.toString()} is ` +
        "already registered.",
    );
  }
  void requirements;
  void warnings;
  const paymentRequired = result.value.paymentRequired;
  logger.info("x402.payment_required", { transport: "mcp" });
  return {
    isError: true,
    structuredContent: paymentRequired,
    content: [{ type: "text", text: JSON.stringify(paymentRequired) }],
  };
}
