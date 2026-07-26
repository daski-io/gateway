import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import { X402_VERSION } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import { defaultBuyerName } from "../identity/name.js";
import { prepareRegistration } from "../identity/service.js";
import { createQuotedChallenge } from "../payment/quotedChallenge.js";
import type { Hex } from "../types.js";
import type { Fetcher } from "./a2a.js";
import type { PaymentScreeningReadinessProbe } from "../payment/screeningReadiness.js";
import type { BuyServiceContext } from "./buyServiceTypes.js";
import { unknownServiceArgWarnings } from "./serviceArgWarnings.js";
import {
  checkBuyerNameAcknowledgement,
  mcpError,
  mcpJson,
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
  // Identity gate runs BEFORE the provider quote is created: a gate hit
  // used to burn a provider quote per firing (observed 6/6 fresh wallets,
  // 2026-07-25), and the retry needed a full re-quote. Now nothing is
  // consumed — the gate error can truthfully say the retry is free.
  if (isAtomic && !buyerName) {
    // Only when the name is being defaulted — passing `name` skips the
    // gate, and `useWalletDerivedName: true` IS the explicit choice.
    const nameError = checkBuyerNameAcknowledgement(
      defaultBuyerName(args.walletAddress.toLowerCase() as Hex),
      args.buyerNameAcknowledgementToken,
      args.useWalletDerivedName,
    );
    if (nameError) return nameError;
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
        ...(args.phoneAcknowledgement
          ? { phone: args.phoneAcknowledgement.values }
          : args.phoneAcknowledgementToken
            ? { phoneTokenUsed: true }
            : {}),
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
  let registrationPrep: unknown = null;
  let registrationName: string | null = null;
  if (isAtomic) {
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
      const { code, message, ...details } = prepared.error;
      return mcpError({
        code,
        message,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      });
    }
    registrationPrep = prepared.value;
    registrationName =
      typeof prepared.value.resolvedName === "string"
        ? prepared.value.resolvedName
        : null;
  }

  const steps: Array<{ toolName: string; hint: string; args: unknown }> = [
    {
      toolName: "<your-wallet>.signTypedData",
      hint: "Sign paymentRequirements.extra.daski.eip712TypedData.",
      args: { typedData: requirements.extra.daski.eip712TypedData },
    },
  ];
  if (isAtomic) {
    steps.push({
      toolName: "<your-wallet>.signTypedData",
      hint:
        "Sign registrationPrep.eip712TypedData with the same wallet. " +
        (buyerName
        ? `This registers the wallet as '${registrationName}'.`
        : `The default name is '${registrationName}'. Re-run with name ` +
            "before signing to choose another display name via `name`."),
      args: {
        typedData: (registrationPrep as { eip712TypedData: unknown })
          .eip712TypedData,
      },
    });
  }
  steps.push(
    {
      toolName: "daski_settle_payment",
      hint: isAtomic
        ? "Pass the payment and signed registration for atomic settlement."
        : "Assemble and submit the signed x402 payment payload.",
      args: {
        paymentPayload: "<signature plus typedData.message>",
        paymentRequirements: requirements,
        ...(isAtomic
          ? {
              registration: {
                agentURI: "<from registrationPrep.agentURI>",
                deadline: "<from registrationPrep.deadline>",
                signature: "<from registration signing step>",
              },
            }
          : {}),
      },
    },
    {
      toolName: "daski_submit_task",
      hint: "Use serviceRef and transactionHash returned by settlement.",
      args: {
        providerA2AUrl: result.value.challenge.providerA2AUrl,
        skillId: args.skillId,
        serviceRef: result.value.challenge.serviceRef,
        paymentId: "<from daski_settle_payment>",
        transactionHash: "<from daski_settle_payment>",
        chainId: deps.config.chainId,
        serviceArgs,
      },
    },
    {
      toolName: "daski_get_task_status",
      hint: "Poll until completed or failed.",
      args: {
        providerA2AUrl: result.value.challenge.providerA2AUrl,
        taskId: "<from daski_submit_task>",
      },
    },
    {
      toolName: "daski_confirm_delivery",
      hint:
        "After completion, call without a signature to receive attestation typed data.",
      args: {
        paymentId: "<from daski_settle_payment>",
        confirmation: "Confirmed",
        attester: args.walletAddress.toLowerCase(),
      },
    },
    {
      toolName: "<your-wallet>.signTypedData",
      hint: "Sign the delivery attestation typed data with the buyer wallet.",
      args: { typedData: "<from daski_confirm_delivery>" },
    },
    {
      toolName: "daski_confirm_delivery",
      hint: "Submit the delegated attestation signature.",
      args: {
        paymentId: "<from daski_settle_payment>",
        confirmation: "Confirmed",
        attester: args.walletAddress.toLowerCase(),
        deadline: "<from first confirmation call>",
        signature: { v: "<v>", r: "<r>", s: "<s>" },
      },
    },
  );

  const warnings = unknownServiceArgWarnings(
    provider.skillMeta,
    args.serviceArgs,
  );
  if (!isAtomic && buyerName) {
    warnings.push(
      `\`name\` was ignored because agentId ${buyerAgentId.toString()} is ` +
        "already registered.",
    );
  }
  const paymentRequired = Buffer.from(
    JSON.stringify(requirements),
  ).toString("base64");

  return mcpJson(
    {
      status: "action-required",
      action: "sign_payment",
      kind: "paid",
      atomic: isAtomic,
      providerTokenId: provider.agentId.toString(),
      providerA2AUrl: result.value.challenge.providerA2AUrl,
      skillId: args.skillId,
      serviceArgs,
      chainId: deps.config.chainId,
      network: deps.config.network,
      ...(warnings.length > 0 ? { warnings } : {}),
      acceptedToken: {
        address: deps.config.usdcAddress,
        name: deps.config.usdcName,
        version: deps.config.usdcVersion,
        chainId: deps.config.chainId,
        network: deps.config.network,
      },
      quoteNotes: result.value.quoteNotes,
      quote: {
        quoteId: result.value.challenge.quoteId,
        expiresAt: result.value.challenge.quoteExpiresAt?.toISOString(),
      },
      legal: requirements.extra.daski.legal,
      agentAuthority: requirements.extra.daski.agentAuthority,
      purchaseNotice: requirements.extra.daski.purchaseNotice,
      paymentRequirements: requirements,
      registrationPrep,
      plan: { steps },
    },
    {
      "x402/paymentRequired": paymentRequired,
      "x402/version": X402_VERSION,
    },
  );
}
