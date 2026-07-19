import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Fetcher } from "../mcp/a2a.js";
import type { Hex, PaymentRequirements, StoredChallenge } from "../types.js";
import {
  issuePaymentRequirements,
  resolveSkillOffer,
  type SkillOffer,
} from "./requirements.js";
import { fetchProviderQuote } from "./providerQuote.js";

export interface QuotedChallengeInput {
  providerAgentId: bigint;
  buyerAgentId: bigint;
  walletAddress: Hex;
  skillId: string;
  serviceArgs: Record<string, unknown>;
  amountLimit?: string;
}

export interface QuotedChallengeDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface QuotedChallengeValue {
  offer: SkillOffer;
  requirements: PaymentRequirements;
  challenge: StoredChallenge;
  quoteNotes: string[];
}

export interface QuotedChallengeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
  nextAction?: string;
}

export type QuotedChallengeResult =
  | { ok: true; value: QuotedChallengeValue }
  | { ok: false; error: QuotedChallengeError };

export async function createQuotedChallenge(
  input: QuotedChallengeInput,
  deps: QuotedChallengeDeps,
): Promise<QuotedChallengeResult> {
  const provider = deps.cache.get(input.providerAgentId);
  if (!provider) {
    return fail("provider_not_found", "provider is not whitelisted");
  }
  const offerResult = resolveSkillOffer(
    input.providerAgentId,
    input.skillId,
    deps.cache,
    { requireFixedAmount: false },
  );
  if (!offerResult.ok) {
    return fail(offerResult.code, offerResult.message);
  }
  const offer = offerResult.offer;
  const quoteResult = await fetchProviderQuote({
    providerA2AUrl: offer.providerA2AUrl,
    skillId: input.skillId,
    serviceArgs: input.serviceArgs,
    expectedSignerAddress: provider.walletAddress,
    expectedChainId: deps.config.chainId,
    expectedTokenAddress: deps.config.usdcAddress,
    expectedServiceSlug: offer.serviceSlug,
    expectedServiceVersion: offer.serviceVersion,
    fetchFn: deps.fetch,
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxResponseBytes,
  });
  if (!quoteResult.ok) {
    return {
      ok: false,
      error: {
        code: quoteResult.code,
        message: quoteResult.message,
        ...(quoteResult.code === "quote_validation_failed"
          ? {
              details: { validationErrors: quoteResult.errors ?? [] },
              recoverable: true,
              nextAction:
                "Fix the listed validationErrors in serviceArgs and retry.",
            }
          : {}),
      },
    };
  }
  if (!quoteResult.paymentRequired || !quoteResult.quote) {
    return fail(
      "quote_commitment_missing",
      "The provider did not issue a signed commitment for this paid skill.",
    );
  }

  const limit = parseAmountLimit(input.amountLimit);
  if (!limit.ok) return limit;
  if (limit.value !== null && BigInt(quoteResult.amount) > limit.value) {
    return {
      ok: false,
      error: {
        code: "price_above_limit",
        message:
          `provider quote ${quoteResult.amount} exceeds the amount limit ` +
          input.amountLimit,
        details: {
          quotedAmount: quoteResult.amount,
          limit: input.amountLimit,
          notes: quoteResult.notes,
        },
        recoverable: true,
        nextAction:
          "Accept the quote by retrying without amountLimit or with a higher limit.",
      },
    };
  }

  const quote = quoteResult.quote;
  const issued = await issuePaymentRequirements(
    {
      providerTokenId: input.providerAgentId,
      buyerTokenId: input.buyerAgentId,
      skillId: input.skillId,
      amount: quoteResult.amount,
      resource: `${deps.config.publicUrl}/purchase/${input.providerAgentId}`,
      walletAddress: input.walletAddress,
      trustQuotedAmount: true,
      providerQuote: {
        quoteId: quote.quoteId,
        serviceRef: quote.serviceRef,
        requestHash: quote.requestHash,
        providerSignature: quote.providerSignature,
        amount: quote.amount,
        expiresAt: new Date(quote.expiresAt),
        skillId: quote.skillId,
        serviceSlug: quote.serviceSlug,
        serviceVersion: quote.serviceVersion,
      },
    },
    deps.config,
    deps.cache,
    deps.queries,
  );
  if (!issued.ok) return fail(issued.code, issued.message);
  return {
    ok: true,
    value: {
      offer,
      requirements: issued.requirements,
      challenge: issued.challenge,
      quoteNotes: quoteResult.notes,
    },
  };
}

function parseAmountLimit(
  raw: string | undefined,
):
  | { ok: true; value: bigint | null }
  | { ok: false; error: QuotedChallengeError } {
  if (raw === undefined) return { ok: true, value: null };
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error("negative");
    return { ok: true, value };
  } catch {
    return fail("BAD_INPUT", "amount must be a non-negative decimal string");
  }
}

function fail(
  code: string,
  message: string,
): { ok: false; error: QuotedChallengeError } {
  return { ok: false, error: { code, message } };
}
