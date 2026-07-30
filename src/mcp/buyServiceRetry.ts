import { computeRequestHash } from "../auth/envelope.js";
import type { Queries } from "../db/queries.js";
import type { ChainDeploymentReadinessProbe } from "../payment/deploymentReadiness.js";
import type { Hex, PaymentPayload } from "../types.js";
import { hashCanonical } from "../payment/requirementResponse.js";
import {
  getDaskiDeclaration,
  getDaskiReceipt,
} from "../payment/x402Extension.js";
import type { BuyServiceArgs } from "./buyServiceTypes.js";
import {
  mcpError,
  mcpJson,
  validateAndNormalizeServiceArgs,
  type McpToolResult,
} from "./util.js";

interface RetryDeps {
  queries: Queries;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  facilitator: import("../payment/daskiFacilitator.js").DaskiFacilitatorService;
}

export async function runBuyServiceX402Retry(
  args: BuyServiceArgs,
  extra: { _meta?: Record<string, unknown> },
  deps: RetryDeps,
): Promise<McpToolResult | null> {
  const metaPaymentRaw = extra._meta?.["x402/payment"];
  const inboundPayload =
    metaPaymentRaw &&
    typeof metaPaymentRaw === "object" &&
    !Array.isArray(metaPaymentRaw)
      ? (metaPaymentRaw as PaymentPayload)
      : undefined;
  if (metaPaymentRaw !== undefined && !inboundPayload) {
    return mcpError({
      code: "invalid_meta_payment",
      message: "_meta['x402/payment'] must be a PaymentPayload object",
      recoverable: true,
    });
  }
  if (!inboundPayload) return null;

  const declaration = getDaskiDeclaration(inboundPayload);
  const serviceRef = declaration?.info.serviceRef;
  if (!serviceRef) {
    return mcpError({
      code: "BAD_INPUT",
      message:
        "PaymentPayload is missing the Daski x402 V2 serviceRef extension.",
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
    !challenge.requestFingerprint ||
    challenge.requestFingerprint.toLowerCase() !==
      hashCanonical(args).toLowerCase()
  ) {
    return mcpError({
      code: "PURCHASE_REQUEST_MISMATCH",
      message: "paid retry arguments differ from the original purchase request",
      recoverable: true,
      next_action: "Retry with the original tool arguments unchanged.",
    });
  }
  if (
    challenge.settlementState !== "paid" &&
    challenge.settlementState !== "sanctions_rejected" &&
    !(await deps.deploymentReadiness.isReady())
  ) {
    return mcpError({
      code: "payment_screening_unready",
      message: "Payment cannot be processed right now. Please try again later.",
      retryable: true,
      recoverable: true,
      next_action: "Retry later while payment screening is available.",
    });
  }
  if (!challenge.quoteRequestHash) {
    return mcpError({
      code: "QUOTE_CREDENTIALS_MISSING",
      message: "stored challenge is missing its quote requestHash",
    });
  }
  const effectiveServiceArgs = args.serviceArgs ?? {};
  if (
    args.serviceArgs === undefined &&
    challenge.quoteRequestHash.toLowerCase() !==
      computeRequestHash({}).toLowerCase()
  ) {
    return mcpError({
      code: "SERVICE_ARGS_REQUIRED",
      message: "The exact serviceArgs used for the signed quote are required.",
      recoverable: true,
      next_action: "Retry with the complete original serviceArgs unchanged.",
    });
  }
  const normalized = validateAndNormalizeServiceArgs(effectiveServiceArgs, []);
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
    retryRequestHash.toLowerCase() !== challenge.quoteRequestHash.toLowerCase()
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

  const requirements = challenge.paymentRequired?.accepts[0];
  if (!requirements) {
    return mcpError({
      code: "INVALID_STORED_CHALLENGE",
      message: "stored challenge is not canonical x402 V2",
    });
  }
  const settlementResult = await deps.facilitator.settleDetailed(
    inboundPayload,
    requirements,
  );
  const settlement = settlementResult.response;
  if (!settlement.success) {
    const retryable = settlement.retryable ?? false;
    const screeningCode = settlement.errorReason;
    const nextAction =
      screeningCode === "SANCTIONS_ADDRESS_REJECTED"
        ? "Do not retry this unchanged payment. Obtain a fresh quote and challenge only if the purchase context changes."
        : screeningCode === "SANCTIONS_SCREENING_UNAVAILABLE"
          ? "Retry later while the original quote and challenge remain valid."
          : retryable
            ? "Retry the same signed payment later."
            : undefined;
    return mcpError(
      {
        code: settlement.errorReason ?? "settlement_failed",
        message: settlement.errorMessage ?? "payment settlement failed",
        retryable,
        recoverable: retryable,
        ...(nextAction ? { next_action: nextAction } : {}),
        details: {
          transaction: settlement.transaction,
          payer: settlement.payer,
        },
      },
      { "x402/payment-response": settlement },
    );
  }

  const receipt = getDaskiReceipt(settlement);
  return mcpJson(
    {
      status: "completed",
      success: true,
      kind: "settled",
      settled: true,
      transaction: settlement.transaction,
      network: settlement.network,
      payer: settlement.payer,
      paymentId: receipt?.paymentId ?? null,
      serviceRef: receipt?.serviceRef ?? serviceRef,
      providerTokenId: receipt?.providerAgentId ?? null,
      buyerTokenId: receipt?.buyerAgentId ?? null,
      amount: settlement.amount ?? null,
      providerA2AUrl: receipt?.providerA2AUrl ?? null,
      skillId: challenge.skillId,
      registered: receipt?.registered ?? false,
      next_action:
        "Call daski_submit_task with serviceRef, transactionHash, paymentId, and buyerTokenId.",
    },
    { "x402/payment-response": settlement },
  );
}
