import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Fetcher } from "../mcp/a2a.js";
import {
  fetchProviderQuote,
  type ProviderQuoteCommitment,
} from "./providerQuote.js";
import type { SkillOffer } from "./skillOffer.js";
import { boundedTimeoutSeconds } from "./bazaarResponse.js";

export type BazaarQuoteResult =
  | {
      ok: true;
      amount: bigint;
      quote: ProviderQuoteCommitment;
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

export interface BazaarQuoteDeps {
  config: Config;
  cache: DiscoveryCache;
  fetch: Fetcher;
  timeoutMs?: number;
}

export async function quoteBazaarProvider(
  offer: SkillOffer,
  skillId: string,
  serviceArgs: Record<string, unknown>,
  deps: BazaarQuoteDeps,
): Promise<BazaarQuoteResult> {
  const provider = deps.cache.get(offer.providerTokenId);
  if (!provider) {
    return failure(
      404,
      "provider_not_found: provider is not in the discovery cache",
    );
  }
  const result = await fetchProviderQuote({
    providerA2AUrl: offer.providerA2AUrl,
    skillId,
    serviceArgs,
    expectedSignerAddress: provider.walletAddress,
    expectedChainId: deps.config.chainId,
    expectedTokenAddress: deps.config.usdcAddress,
    expectedServiceSlug: offer.serviceSlug,
    expectedServiceVersion: offer.serviceVersion,
    fetchFn: deps.fetch,
    timeoutMs: deps.timeoutMs,
  });
  if (!result.ok) {
    if (result.code === "quote_validation_failed") {
      return {
        ok: false,
        status: 422,
        body: {
          x402Version: 2,
          error: "quote_validation_failed: fix body.serviceArgs and retry",
          validationErrors: result.errors ?? [],
        },
      };
    }
    return failure(502, `${result.code}: ${result.message}`);
  }
  let amount: bigint;
  try {
    amount = BigInt(result.amount);
  } catch {
    return failure(
      502,
      "quote_malformed: provider quote amount is not numeric",
    );
  }
  if (amount <= 0n || !result.paymentRequired) {
    return failure(
      404,
      "skill_is_free: nothing to purchase for these serviceArgs",
    );
  }
  if (!result.quote) {
    return failure(
      503,
      "quote_commitment_missing: provider issued no signed quote commitment; " +
        "this resource cannot settle safely until the provider is upgraded",
    );
  }
  if (boundedTimeoutSeconds(deps.config, result.quote) === null) {
    return failure(
      409,
      "quote_expired: provider quote has less than 15 seconds remaining",
    );
  }
  return { ok: true, amount, quote: result.quote };
}

function failure(status: number, error: string): BazaarQuoteResult {
  return {
    ok: false,
    status,
    body: { x402Version: 2, error },
  };
}
