import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";

interface ChallengeBinding {
  serviceRef: Hex;
  providerTokenId: bigint;
  buyerTokenId: bigint;
  amount: bigint;
  skillId: string;
  serviceSlug: string;
  serviceVersion: string;
  serviceId: Hex;
  providerA2AUrl: string;
  walletAddress: Hex;
  expiresAt: Date;
  quote: {
    quoteId: string;
    providerSignature: Hex;
    expiresAt: Date;
    requestHash: Hex;
  };
}

export type ClaimChallengeResult =
  | { ok: true; existingChallenge: StoredChallenge | null }
  | { ok: false; code: string; message: string; status: number };

function matchesBinding(
  existing: StoredChallenge,
  binding: ChallengeBinding,
  now: Date,
): boolean {
  return (
    existing.status === "pending" &&
    existing.expiresAt.getTime() > now.getTime() + 15_000 &&
    existing.providerTokenId === binding.providerTokenId &&
    existing.buyerTokenId === binding.buyerTokenId &&
    existing.amount === binding.amount &&
    existing.skillId === binding.skillId &&
    existing.serviceSlug === binding.serviceSlug &&
    existing.serviceVersion === binding.serviceVersion &&
    existing.serviceId.toLowerCase() === binding.serviceId.toLowerCase() &&
    existing.providerA2AUrl === binding.providerA2AUrl &&
    existing.walletAddress.toLowerCase() ===
      binding.walletAddress.toLowerCase() &&
    existing.quoteId === binding.quote.quoteId &&
    existing.quoteSignature?.toLowerCase() ===
      binding.quote.providerSignature.toLowerCase() &&
    existing.quoteRequestHash?.toLowerCase() ===
      binding.quote.requestHash.toLowerCase()
  );
}

function quoteAlreadyUsed(message: string): ClaimChallengeResult {
  return {
    ok: false,
    code: "quote_already_used",
    message,
    status: 409,
  };
}

/**
 * Atomically binds a provider quote to one pending payment challenge.
 * Concurrent claims either observe the same binding or fail closed.
 */
export async function claimPaymentChallenge(
  binding: ChallengeBinding,
  queries: Queries,
  now: Date,
): Promise<ClaimChallengeResult> {
  let existingChallenge = await queries.getChallengeByRef(binding.serviceRef);
  if (existingChallenge && !matchesBinding(existingChallenge, binding, now)) {
    return quoteAlreadyUsed(
      "this provider quote is already bound to a different or completed " +
        "payment challenge; request a fresh quote",
    );
  }

  if (!existingChallenge) {
    try {
      await queries.insertChallenge({
        serviceRef: binding.serviceRef,
        providerTokenId: binding.providerTokenId,
        buyerTokenId: binding.buyerTokenId,
        amount: binding.amount,
        skillId: binding.skillId,
        serviceSlug: binding.serviceSlug,
        serviceVersion: binding.serviceVersion,
        serviceId: binding.serviceId,
        providerA2AUrl: binding.providerA2AUrl,
        walletAddress: binding.walletAddress,
        expiresAt: binding.expiresAt,
        quoteId: binding.quote.quoteId,
        quoteSignature: binding.quote.providerSignature,
        quoteExpiresAt: binding.quote.expiresAt,
        quoteRequestHash: binding.quote.requestHash,
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "23505"
      ) {
        existingChallenge = await queries.getChallengeByRef(binding.serviceRef);
        if (
          !existingChallenge ||
          !matchesBinding(existingChallenge, binding, now)
        ) {
          return quoteAlreadyUsed(
            "this provider quote was claimed by another payment challenge; " +
              "request a fresh quote",
          );
        }
      } else {
        throw error;
      }
    }
  }

  return { ok: true, existingChallenge };
}
