import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Router, type Request, type Response } from "express";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import { X402_VERSION } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Hex, PaymentPayload } from "../types.js";
import { logger } from "../util/logger.js";
import type { ChainDeploymentReadinessProbe } from "./deploymentReadiness.js";
import type { DaskiFacilitatorService } from "./daskiFacilitator.js";
import type { ProviderAuthorityService } from "./providerAuthority.js";
import { parsePurchaseRequest } from "./purchaseRequest.js";
import { hashCanonical } from "./requirementResponse.js";
import { issuePaymentRequirements } from "./requirements.js";
import { getDaskiDeclaration, getDaskiReceipt } from "./x402Extension.js";

export interface PurchaseDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  facilitator: DaskiFacilitatorService;
  providerAuthority: ProviderAuthorityService;
  fetchAgentCardFn?: import("../identity/fetch-agent-card.js").FetchAgentCardOptions["fetchFn"];
}

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ x402Version: X402_VERSION, error: message });
}

// Fail-closed is correct — but a silent refusal of a paid POST cost an
// hour of forensics on 2026-08-01. Every readiness refusal logs the
// probe's reason and puts it in the body: `rpc_unavailable` in the
// response is what lets the e2e runner's INFRA classifier recognize this
// as retryable infrastructure noise rather than a product failure.
function refuseUnready(
  deps: PurchaseDeps,
  res: Response,
  site: "initial_purchase" | "paid_retry",
) {
  const { failedCheck } = deps.deploymentReadiness.status();
  const reason = failedCheck ?? "unready";
  logger.warn("x402.readiness_refused", {
    transport: "http",
    site,
    failedCheck: reason,
  });
  res.status(503).json({
    x402Version: X402_VERSION,
    error: "Payment cannot be processed right now. Please try again later.",
    reason,
    retryable: true,
  });
}

export function createPurchaseRouter(deps: PurchaseDeps): Router {
  const router = Router();

  router.post("/purchase/:agentId", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.get("X-PAYMENT")) {
      logger.info("x402.v1_request_rejected", { transport: "http" });
      sendError(res, 400, "X-PAYMENT is not supported; use PAYMENT-SIGNATURE");
      return;
    }
    const providerTokenId = parseAgentId(req.params.agentId);
    if (providerTokenId === null) {
      sendError(res, 404, "invalid provider token id");
      return;
    }

    const signatureHeader = req.get("PAYMENT-SIGNATURE");
    if (signatureHeader) {
      await handlePaidRetry(
        deps,
        providerTokenId,
        req.body ?? {},
        signatureHeader,
        res,
      );
      return;
    }
    await handleInitialPurchase(deps, providerTokenId, req.body ?? {}, res);
  });

  return router;
}

async function handlePaidRetry(
  deps: PurchaseDeps,
  providerTokenId: bigint,
  body: Record<string, unknown>,
  signatureHeader: string,
  res: Response,
): Promise<void> {
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(signatureHeader);
  } catch {
    sendError(res, 400, "malformed PAYMENT-SIGNATURE");
    return;
  }
  const declaration = getDaskiDeclaration(paymentPayload);
  if (!declaration) {
    sendError(res, 400, "PAYMENT-SIGNATURE is missing the Daski V2 extension");
    return;
  }
  const challenge = await deps.queries.getChallengeByRef(
    declaration.info.serviceRef.toLowerCase() as Hex,
  );
  if (!challenge || challenge.providerTokenId !== providerTokenId) {
    sendError(res, 404, "payment challenge not found");
    return;
  }
  if (
    !challenge.requestFingerprint ||
    challenge.requestFingerprint.toLowerCase() !==
      hashCanonical(body).toLowerCase()
  ) {
    sendError(res, 400, "paid retry body differs from the original request");
    return;
  }
  if (
    challenge.settlementState !== "paid" &&
    challenge.settlementState !== "sanctions_rejected" &&
    !(await deps.deploymentReadiness.isReady())
  ) {
    refuseUnready(deps, res, "paid_retry");
    return;
  }
  const requirements = challenge.paymentRequired?.accepts[0];
  if (!requirements) {
    sendError(res, 409, "stored challenge is not canonical x402 V2");
    return;
  }
  const settlementResult = await deps.facilitator.settleDetailed(
    paymentPayload,
    requirements,
  );
  const settlement = settlementResult.response;
  res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement));
  if (!settlement.success) {
    res.status(settlementResult.ok ? 500 : settlementResult.status).json({
      error: settlement.errorReason,
      message: settlement.errorMessage,
      retryable: settlement.retryable ?? false,
    });
    return;
  }
  const receipt = getDaskiReceipt(settlement);
  res.status(200).json({
    success: true,
    receipt,
    amount: settlement.amount,
    transactionHash: settlement.transaction,
    nextAction: "Submit the paid task to the provider A2A endpoint.",
  });
}

async function handleInitialPurchase(
  deps: PurchaseDeps,
  providerTokenId: bigint,
  body: Record<string, unknown>,
  res: Response,
): Promise<void> {
  if (!(await deps.deploymentReadiness.isReady())) {
    refuseUnready(deps, res, "initial_purchase");
    return;
  }
  const parsed = await parsePurchaseRequest(deps, providerTokenId, body, res);
  if (!parsed) return;

  const result = await issuePaymentRequirements(
    {
      providerTokenId,
      buyerTokenId: parsed.buyerTokenId,
      skillId: parsed.skillId,
      resource: `${deps.config.publicUrl}/purchase/${providerTokenId}`,
      walletAddress: parsed.walletAddress,
      providerQuote: parsed.providerQuote,
      serviceArgs: parsed.serviceArgs,
      warnings: [],
      requestFingerprint: hashCanonical(body),
      registrationDelegation: parsed.registration,
      providerAuthority: parsed.providerAuthority,
    },
    deps.config,
    deps.cache,
    deps.queries,
    deps.reader,
  );
  if (!result.ok) {
    sendError(res, result.status, result.message);
    return;
  }
  const encoded = encodePaymentRequiredHeader(result.paymentRequired);
  if (Buffer.byteLength(encoded, "utf8") >= 8192) {
    logger.warn("x402.header_oversize", { transport: "http" });
    sendError(
      res,
      500,
      "payment challenge exceeds the configured header budget",
    );
    return;
  }
  logger.info("x402.payment_required", { transport: "http" });
  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.status(402).json({
    error: "payment_required",
    legal: result.purchaseLegal.legal,
    agentAuthority: result.purchaseLegal.agentAuthority,
    purchaseNotice: result.purchaseLegal.purchaseNotice,
  });
}

function parseAgentId(value: unknown): bigint | null {
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}
