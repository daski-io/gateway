import type { Response } from "express";
import type { ParsedBazaarAuthorization } from "./bazaarAuthorization.js";
import { acceptedProviderQuote } from "./bazaarPayment.js";
import type { BazaarDeps, BazaarRequestContext } from "./bazaarRequest.js";
import { quoteOrRespond } from "./bazaarRequest.js";
import {
  boundedTimeoutSeconds,
  buildPaymentRequired,
} from "./bazaarResponse.js";
import {
  validateProviderQuoteCommitment,
  type ProviderQuoteCommitment,
} from "./providerQuote.js";

export async function validateAcceptedQuote(
  response: Response,
  request: BazaarRequestContext,
  authorization: ParsedBazaarAuthorization,
  deps: BazaarDeps,
): Promise<{ amount: bigint; quote: ProviderQuoteCommitment } | null> {
  const rawQuote = acceptedProviderQuote(authorization.core);
  const rawAmount =
    rawQuote && typeof rawQuote === "object"
      ? (rawQuote as Record<string, unknown>).amount
      : undefined;
  const provider = deps.cache.get(request.providerTokenId);
  const validation =
    provider && typeof rawAmount === "string"
      ? await validateProviderQuoteCommitment(rawQuote, {
          skillId: request.skillId,
          serviceArgs: request.serviceArgs,
          amount: rawAmount,
          expectedSignerAddress: provider.walletAddress,
          expectedChainId: deps.config.chainId,
          expectedTokenAddress: deps.config.usdcAddress,
          expectedServiceSlug: request.offer.serviceSlug,
          expectedServiceVersion: request.offer.serviceVersion,
        })
      : { ok: false as const, message: "accepted quote is missing" };
  if (validation.ok) {
    return { amount: BigInt(validation.quote.amount), quote: validation.quote };
  }
  const replacement = await quoteOrRespond(
    response,
    request.offer,
    request.skillId,
    request.serviceArgs,
    deps,
  );
  if (!replacement) return null;
  const timeout = boundedTimeoutSeconds(deps.config, replacement.quote);
  if (timeout === null) {
    response.status(409).json({
      x402Version: authorization.core.version,
      error: "quote_expired: request a fresh provider quote",
    });
    return null;
  }
  response.status(402).json(
    buildPaymentRequired(
      request.offer,
      replacement.amount,
      deps.config,
      request.resourceUrl,
      timeout,
      request.purchaseLegal!,
      replacement.quote,
      "payment header does not carry the valid quote from the prior 402 " +
        `(${validation.message}); sign the replacement requirements`,
    ),
  );
  return null;
}
