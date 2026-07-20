import type { StoredChallenge } from "../types.js";
import type { BazaarExternalSettlementInput } from "./bazaarExternalSettlement.js";

export async function insertBazaarChallenge(
  input: BazaarExternalSettlementInput,
  amount: bigint,
): Promise<StoredChallenge | null> {
  const { request, response, from, authNonce, buyerAgentId, deps } = input;
  const quote = input.quoted!.quote;
  const expiresAt = new Date(
    Math.min(
      Date.now() + deps.config.challengeTtlSeconds * 1000,
      Date.parse(quote.expiresAt),
    ),
  );
  try {
    await deps.queries.insertChallenge({
      serviceRef: quote.serviceRef,
      providerTokenId: request.providerTokenId,
      buyerTokenId: buyerAgentId,
      amount,
      skillId: request.skillId,
      serviceSlug: request.offer.serviceSlug,
      serviceVersion: request.offer.serviceVersion,
      serviceId: request.offer.serviceId,
      providerA2AUrl: request.offer.providerA2AUrl,
      walletAddress: from,
      expiresAt,
      rail: "external",
      authNonce,
      quoteId: quote.quoteId,
      quoteSignature: quote.providerSignature,
      quoteExpiresAt: new Date(quote.expiresAt),
      quoteRequestHash: quote.requestHash,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      response.status(409).json({
        x402Version: input.core.version,
        error: "this payment is already being processed; retry shortly",
      });
      return null;
    }
    throw error;
  }
  const challenge = await deps.queries.getChallengeByWalletAndNonce(
    from,
    authNonce,
  );
  if (!challenge) {
    response.status(500).json({
      x402Version: input.core.version,
      error: "challenge row vanished after insert",
    });
  }
  return challenge;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}
