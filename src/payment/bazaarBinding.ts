import type { Response } from "express";
import type { StoredChallenge } from "../types.js";
import { publicErrorMessage } from "../util/errorWrap.js";
import type { ParsedBazaarAuthorization } from "./bazaarAuthorization.js";
import { validateAcceptedQuote } from "./bazaarAcceptedQuote.js";
import {
  sendRegistrationRequired,
  sendStoredReceipt,
} from "./bazaarBindingResponses.js";
import type { BazaarDeps, BazaarRequestContext } from "./bazaarRequest.js";
import {
  boundedTimeoutSeconds,
  buildPaymentRequired,
} from "./bazaarResponse.js";
import type { ProviderQuoteCommitment } from "./providerQuote.js";

const VALID_BEFORE_BUFFER_SEC = 10n;

export interface BazaarBinding {
  challenge: StoredChallenge | null;
  quoted: { amount: bigint; quote: ProviderQuoteCommitment } | null;
  authorizationConsumed: boolean;
  buyerAgentId: bigint;
}

export async function resolveBazaarBinding(
  response: Response,
  request: BazaarRequestContext,
  authorization: ParsedBazaarAuthorization,
  deps: BazaarDeps,
): Promise<BazaarBinding | null> {
  const { from, authNonce, value, validAfter, validBefore, core } = authorization;
  let challenge = await deps.queries.getChallengeByWalletAndNonce(
    from,
    authNonce,
  );
  let authorizationConsumed = false;
  if (challenge) {
    const existing = await validateExistingChallenge(
      response,
      request,
      authorization,
      challenge,
      deps,
    );
    if (!existing) return null;
    if (existing.responded) return null;
    authorizationConsumed = existing.authorizationConsumed;
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (
    !authorizationConsumed &&
    (validAfter > nowSec || validBefore <= nowSec + VALID_BEFORE_BUFFER_SEC)
  ) {
    response.status(400).json({
      x402Version: core.version,
      error:
        "authorization is not currently valid (validAfter/validBefore window)",
    });
    return null;
  }
  if (challenge) {
    return {
      challenge,
      quoted: null,
      authorizationConsumed,
      buyerAgentId: challenge.buyerTokenId,
    };
  }
  if (!request.purchaseLegal) {
    response.status(409).json({
      x402Version: core.version,
      error: "payment_recovery_state_missing",
      message:
        "The persisted purchase state disappeared during recovery. No new " +
        "payment requirements were issued because the Provider's legal " +
        "metadata is currently invalid.",
    });
    return null;
  }
  let buyerAgentId: bigint;
  try {
    buyerAgentId = await deps.reader.agentOfWallet(from);
  } catch (error) {
    response.status(503).json({
      x402Version: core.version,
      error: publicErrorMessage(
        "bazaar.agentOfWallet",
        error,
        "unable to resolve buyer identity",
      ),
    });
    return null;
  }
  if (buyerAgentId === 0n) {
    sendRegistrationRequired(response, request, deps);
    return null;
  }
  const quoted = await validateAcceptedQuote(
    response,
    request,
    authorization,
    deps,
  );
  if (!quoted) return null;
  if (value !== quoted.amount) {
    const timeout = boundedTimeoutSeconds(deps.config, quoted.quote);
    if (timeout === null) {
      response.status(410).json({
        x402Version: core.version,
        error: "the accepted provider quote is too close to expiry",
      });
      return null;
    }
    response.status(402).json(
      buildPaymentRequired(
        request.offer,
        quoted.amount,
        deps.config,
        request.resourceUrl,
        timeout,
        request.purchaseLegal,
        quoted.quote,
        `authorization value ${core.authorization.value} does not match the ` +
          `quoted amount ${quoted.amount.toString()}`,
      ),
    );
    return null;
  }
  return { challenge, quoted, authorizationConsumed, buyerAgentId };
}

async function validateExistingChallenge(
  response: Response,
  request: BazaarRequestContext,
  authorization: ParsedBazaarAuthorization,
  challenge: StoredChallenge,
  deps: BazaarDeps,
): Promise<{ responded: boolean; authorizationConsumed: boolean } | null> {
  const mismatch =
    challenge.providerTokenId !== request.providerTokenId ||
    challenge.serviceSlug !== request.serviceSlug ||
    challenge.skillId !== request.skillId ||
    challenge.amount !== authorization.value;
  if (mismatch) {
    response.status(409).json({
      x402Version: authorization.core.version,
      error:
        "this authorization nonce is already bound to a different Daski " +
        "purchase; sign a fresh authorization",
    });
    return null;
  }
  if (
    !challenge.quoteRequestHash ||
    challenge.quoteRequestHash.toLowerCase() !==
      request.serviceArgsHash.toLowerCase()
  ) {
    response.status(409).json({
      x402Version: authorization.core.version,
      error:
        "serviceArgs differ from the request bound to this authorization's " +
        "provider quote",
    });
    return null;
  }
  if (challenge.settlementState === "paid" && challenge.paymentId !== null) {
    sendStoredReceipt(response, request, authorization, challenge, deps);
    return { responded: true, authorizationConsumed: true };
  }
  let consumed = false;
  if (!challenge.externalSettleTx) {
    try {
      consumed = await deps.reader.authorizationUsed(
        authorization.from,
        authorization.authNonce,
      );
    } catch (error) {
      response.status(503).json({
        x402Version: authorization.core.version,
        error: publicErrorMessage(
          "bazaar.authorizationUsed",
          error,
          "unable to determine whether the payment was settled",
        ),
      });
      return null;
    }
  }
  if (
    challenge.settlementState === "expired" &&
    !challenge.externalSettleTx &&
    !consumed
  ) {
    response.status(410).json({
      x402Version: authorization.core.version,
      error:
        "the pending purchase for this authorization has expired; request a " +
        "fresh 402 (fresh quote) and sign a new authorization",
    });
    return null;
  }
  return { responded: false, authorizationConsumed: consumed };
}
