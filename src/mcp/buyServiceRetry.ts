import { computeRequestHash } from "../auth/envelope.js";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import type { PaymentScreeningReadinessProbe } from "../payment/screeningReadiness.js";
import { settleChallenge } from "../payment/settlementCoordinator.js";
import type {
  Hex,
  PaymentPayload,
  PaymentRequirements,
} from "../types.js";
import type { BuyServiceArgs } from "./buyServiceTypes.js";
import {
  mcpError,
  mcpJson,
  validateAndNormalizeServiceArgs,
  type McpToolResult,
} from "./util.js";

interface RetryDeps {
  config: Config;
  reader: ChainReader;
  queries: Queries;
  screeningReadiness: PaymentScreeningReadinessProbe;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

export async function runBuyServiceX402Retry(
  args: BuyServiceArgs,
  extra: { _meta?: Record<string, unknown> },
  deps: RetryDeps,
): Promise<McpToolResult | null> {
  const metaPaymentRaw = extra._meta?.["x402/payment"];
  let inboundPayload =
    (args.paymentPayload as PaymentPayload | undefined) ?? undefined;
  if (!inboundPayload && typeof metaPaymentRaw === "string") {
    try {
      inboundPayload = JSON.parse(
        Buffer.from(metaPaymentRaw, "base64").toString("utf8"),
      ) as PaymentPayload;
    } catch {
      return mcpError({
        code: "invalid_meta_payment",
        message: "_meta['x402/payment'] is not valid base64-encoded JSON",
        recoverable: true,
        next_action:
          "Encode the PaymentPayload as base64 JSON or pass paymentPayload directly.",
      });
    }
  }
  if (!inboundPayload) return null;

  const requirements = args.paymentRequirements as
    | PaymentRequirements
    | undefined;
  const serviceRef = requirements?.extra?.daski?.serviceRef;
  if (
    typeof serviceRef !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(serviceRef)
  ) {
    return mcpError({
      code: "BAD_INPUT",
      message:
        "Pass the original paymentRequirements with paymentPayload so the " +
        "gateway can locate serviceRef.",
      recoverable: true,
    });
  }
  const challenge = await deps.queries.getChallengeByRef(
    serviceRef.toLowerCase() as Hex,
  );
  if (!challenge) {
    return mcpError({
      code: "CHALLENGE_NOT_FOUND",
      message: "no challenge found for the given serviceRef",
      details: { serviceRef },
    });
  }
  if (
    challenge.settlementState !== "paid" &&
    challenge.settlementState !== "sanctions_rejected" &&
    !(await deps.screeningReadiness.isReady())
  ) {
    return mcpError({
      code: "payment_screening_unready",
      message: "Payment cannot be processed right now. Please try again later.",
      retryable: true,
      recoverable: true,
      next_action: "Retry later while payment screening is available.",
    });
  }
  if (args.serviceArgs === undefined) {
    return mcpError({
      code: "QUOTE_REQUEST_ARGS_MISSING",
      message: "serviceArgs is required on a signed retry",
      recoverable: true,
      next_action:
        "Re-include the identical serviceArgs object from your first call " +
        "verbatim — nothing removed — alongside paymentPayload and " +
        "paymentRequirements. Do NOT re-sign or re-quote; the existing " +
        "payment signature is still valid.",
    });
  }
  if (!challenge.quoteRequestHash) {
    return mcpError({
      code: "QUOTE_CREDENTIALS_MISSING",
      message: "stored challenge is missing its quote requestHash",
    });
  }
  const normalized = validateAndNormalizeServiceArgs(args.serviceArgs, []);
  if (!normalized.ok) return normalized.error;
  let retryRequestHash: Hex;
  try {
    retryRequestHash = computeRequestHash(normalized.args);
  } catch {
    return mcpError({
      code: "BAD_INPUT",
      message: "serviceArgs cannot be canonically encoded",
      recoverable: true,
    });
  }
  if (
    retryRequestHash.toLowerCase() !==
    challenge.quoteRequestHash.toLowerCase()
  ) {
    return mcpError({
      code: "QUOTE_REQUEST_MISMATCH",
      message:
        "serviceArgs do not match the request committed by the provider quote",
      recoverable: true,
      next_action:
        "Retry with the exact serviceArgs used to create the challenge.",
    });
  }

  const coordinated = await settleChallenge(deps, {
    challenge,
    paymentPayload: inboundPayload,
    registration: args.registration,
  });
  if (coordinated.kind === "registration-required") {
    return mcpError({
      code: "registration_required",
      message:
        "This challenge needs the signed registration returned by the first call.",
      recoverable: true,
      next_action:
        "Sign registrationPrep.eip712TypedData and pass registration.",
    });
  }
  if (coordinated.kind === "invalid-registration") {
    return mcpError({
      code: "invalid_registration",
      message: coordinated.message,
    });
  }
  if (!coordinated.result.ok) {
    const failure = coordinated.result;
    return mcpError({
      code: failure.errorReason,
      message: failure.message,
      ...(failure.screeningFailure
        ? {
            retryable: failure.screeningFailure.retryable,
            recoverable: failure.screeningFailure.retryable,
            next_action: failure.screeningFailure.retryable
              ? "Retry later while the provider quote remains valid."
              : "Do not retry this unchanged payment.",
          }
        : {}),
      details: {
        transaction: failure.response.transaction,
        payer: failure.response.payer,
      },
    });
  }

  const settlement = coordinated.result.response;
  const paymentResponse = Buffer.from(JSON.stringify(settlement)).toString(
    "base64",
  );
  return mcpJson(
    {
      success: true,
      kind: "settled",
      settled: true,
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
      paymentId: settlement.daski?.paymentId ?? null,
      serviceRef: settlement.daski?.serviceRef ?? serviceRef,
      providerTokenId: settlement.daski?.providerTokenId ?? null,
      buyerTokenId: settlement.daski?.buyerTokenId ?? null,
      amount: settlement.daski?.amount ?? null,
      providerA2AUrl: settlement.daski?.providerA2AUrl ?? null,
      skillId: challenge.skillId,
      registered: settlement.daski?.registered ?? false,
      next_action:
        "Call daski_submit_task with serviceRef, transactionHash, paymentId, and buyerTokenId.",
    },
    { "x402/paymentResponse": paymentResponse },
  );
}
