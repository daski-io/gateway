import { computeRequestHash } from "../auth/envelope.js";
import type { Queries } from "../db/queries.js";
import type { PaymentScreeningReadinessProbe } from "../payment/screeningReadiness.js";
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
  screeningReadiness: PaymentScreeningReadinessProbe;
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
  // Flow-state restore (migration 017): the canonical serviceArgs the
  // quote committed to are stored on the challenge row, so the signed
  // retry may omit them entirely — the hash check below still verifies
  // the restored bytes against the quote commitment.
  let effectiveServiceArgs = args.serviceArgs;
  let restoredFromQuote = false;
  if (effectiveServiceArgs === undefined && challenge.serviceArgs) {
    effectiveServiceArgs = challenge.serviceArgs;
    restoredFromQuote = true;
  }
  if (effectiveServiceArgs === undefined) {
    return mcpError({
      code: "QUOTE_REQUEST_ARGS_MISSING",
      message:
        "serviceArgs is required on a signed retry for this quote (it " +
        "predates stored flow state).",
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

  const requirements = challenge.paymentRequired?.accepts[0];
  if (!requirements) {
    return mcpError({
      code: "INVALID_STORED_CHALLENGE",
      message: "stored challenge is not canonical x402 V2",
    });
  }
  const settlement = await deps.facilitator.settle(
    inboundPayload,
    requirements,
  );
  if (!settlement.success) {
    return mcpError(
      {
        code: settlement.errorReason ?? "settlement_failed",
        message: settlement.errorMessage ?? "payment settlement failed",
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
      ...(restoredFromQuote ? { serviceArgsRestored: true } : {}),
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
