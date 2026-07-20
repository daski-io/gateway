import type { Response } from "express";
import type { Hex, StoredChallenge } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import {
  buildFacilitatorRequirements,
  buildForwardedPayload,
  type BazaarPayment,
} from "./bazaarPayment.js";
import type { BazaarDeps, BazaarRequestContext } from "./bazaarRequest.js";
import { buildPaymentRequired } from "./bazaarResponse.js";
import type { ProviderQuoteCommitment } from "./providerQuote.js";
import { insertBazaarChallenge } from "./bazaarChallenge.js";

export interface BazaarExternalSettlementInput {
  response: Response;
  request: BazaarRequestContext;
  core: BazaarPayment;
  from: Hex;
  authNonce: Hex;
  challenge: StoredChallenge | null;
  quoted: { amount: bigint; quote: ProviderQuoteCommitment } | null;
  authorizationConsumed: boolean;
  buyerAgentId: bigint;
  deps: BazaarDeps;
}

export async function ensureExternalSettlement(
  input: BazaarExternalSettlementInput,
): Promise<{
  challenge: StoredChallenge;
  authorizationConsumed: boolean;
} | null> {
  const { response, request, core, from, authNonce, deps } = input;
  const { config, queries, reader, facilitator } = deps;
  let { challenge, authorizationConsumed } = input;
  const effectiveAmount = challenge ? challenge.amount : input.quoted!.amount;
  const quoteExpiresAtMs = challenge
    ? (challenge.quoteExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY)
    : Date.parse(input.quoted!.quote.expiresAt);
  const quoteRunway = Math.floor((quoteExpiresAtMs - Date.now()) / 1000);
  let needsExternalSettle =
    !challenge?.externalSettleTx && !authorizationConsumed;
  if (needsExternalSettle && quoteRunway < 15) {
    response.status(410).json({
      x402Version: core.version,
      error:
        "the provider quote has expired or has less than 15 seconds " +
        "remaining; request a fresh 402 and sign a new authorization",
    });
    return null;
  }
  const timeoutSeconds = Math.max(
    1,
    Math.min(config.challengeTtlSeconds, quoteRunway),
  );
  const facilitatorBody = {
    x402Version: core.version,
    paymentPayload: buildForwardedPayload(
      core,
      request.offer,
      request.resourceUrl,
    ),
    paymentRequirements: buildFacilitatorRequirements(
      effectiveAmount,
      config,
      timeoutSeconds,
    ),
  };
  if (needsExternalSettle) {
    let verify;
    try {
      verify = await facilitator.verify(facilitatorBody);
    } catch (error) {
      response.status(502).json({
        x402Version: core.version,
        error: publicErrorMessage(
          "bazaar.externalVerify",
          error,
          "external payment verification failed",
        ),
      });
      return null;
    }
    if (!verify.isValid && challenge) {
      try {
        authorizationConsumed = await reader.authorizationUsed(
          from,
          authNonce,
        );
        if (authorizationConsumed) needsExternalSettle = false;
      } catch (error) {
        response.status(503).json({
          x402Version: core.version,
          error: publicErrorMessage(
            "bazaar.authorizationUsedAfterVerify",
            error,
            "unable to reconcile the rejected payment authorization",
          ),
        });
        return null;
      }
    }
    if (!verify.isValid && needsExternalSettle) {
      sendFacilitatorFailure(
        response,
        input,
        effectiveAmount,
        timeoutSeconds,
        "verification",
        verify.invalidReason ?? "invalid",
      );
      return null;
    }
    if (!challenge) {
      challenge = await insertBazaarChallenge(input, effectiveAmount);
      if (!challenge) return null;
    }
    if (needsExternalSettle) {
      let settle;
      try {
        settle = await facilitator.settle(facilitatorBody);
      } catch (error) {
        response.status(502).json({
          x402Version: core.version,
          error: publicErrorMessage(
            "bazaar.externalSettle",
            error,
            "external payment settlement failed",
          ),
        });
        return null;
      }
      if (!settle.success) {
        sendFacilitatorFailure(
          response,
          input,
          effectiveAmount,
          timeoutSeconds,
          "settlement",
          settle.errorReason ?? "unknown",
        );
        return null;
      }
      const settleTx = (settle.transaction ?? "") as Hex;
      if (settleTx) {
        const recorded = await queries.recordChallengeExternallySettled(
          challenge.serviceRef,
          settleTx,
        );
        if (!recorded) {
          challenge = await queries.getChallengeByRef(challenge.serviceRef);
          if (!challenge?.externalSettleTx) {
            response.status(409).json({
              x402Version: core.version,
              error:
                "payment settled externally but the challenge state changed; " +
                "retry this exact request to resume attribution",
            });
            return null;
          }
        } else {
          challenge = {
            ...challenge,
            settlementState: "external_settled",
            externalSettleTx: settleTx,
          };
        }
      } else {
        await queries.recordChallengeExternalAuthorizationConsumed(
          challenge.serviceRef,
        );
        challenge = { ...challenge, settlementState: "external_settled" };
      }
    }
  }
  if (!challenge) {
    response.status(500).json({
      x402Version: core.version,
      error: "challenge row missing after external settlement",
    });
    return null;
  }
  return { challenge, authorizationConsumed };
}

function sendFacilitatorFailure(
  response: Response,
  input: BazaarExternalSettlementInput,
  amount: bigint,
  timeoutSeconds: number,
  phase: "verification" | "settlement",
  reason: string,
): void {
  if (!input.request.purchaseLegal) {
    response.status(phase === "verification" ? 409 : 502).json({
      x402Version: input.core.version,
      error:
        phase === "verification"
          ? "payment_recovery_verification_failed"
          : "payment_recovery_settlement_failed",
      message:
        `The external facilitator could not complete payment ${phase} (${reason}). ` +
        "The existing challenge remains available for reconciliation; no new " +
        "payment requirements were issued.",
    });
    return;
  }
  response.status(402).json(
    buildPaymentRequired(
      input.request.offer,
      amount,
      input.deps.config,
      input.request.resourceUrl,
      timeoutSeconds,
      input.request.purchaseLegal,
      undefined,
      `external facilitator ${phase} failed: ${reason}`,
    ),
  );
}
