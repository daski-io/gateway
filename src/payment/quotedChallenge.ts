import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import type { Fetcher } from "../mcp/a2a.js";
import type {
  Hex,
  PaymentRequired,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import { issuePaymentRequirements } from "./requirements.js";
import { resolveSkillOffer, type SkillOffer } from "./skillOffer.js";
import { fetchProviderQuote } from "./providerQuote.js";
import type { ChainReader } from "../chain/reader.js";
import { walletControlsAgent } from "../identity/control.js";
import type { ChainDeploymentReadinessProbe } from "./deploymentReadiness.js";
import { logger } from "../util/logger.js";
import { isSelfPurchase } from "./selfPurchase.js";
import {
  ProviderAuthorityError,
  type ProviderAuthorityService,
} from "./providerAuthority.js";

export interface QuotedChallengeInput {
  providerAgentId: bigint;
  buyerAgentId: bigint;
  walletAddress: Hex;
  skillId: string;
  serviceSlug: string;
  serviceArgs: Record<string, unknown>;
  warnings: string[];
  amountLimit?: string;
  requestFingerprint?: Hex;
  registrationDelegation?: StoredChallenge["registrationDelegation"];
}

export interface QuotedChallengeDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  fetch: Fetcher;
  timeoutMs: number;
  maxResponseBytes: number;
  deploymentReadiness: ChainDeploymentReadinessProbe;
  providerAuthority: ProviderAuthorityService;
}

export interface QuotedChallengeValue {
  offer: SkillOffer;
  requirements: PaymentRequirements;
  paymentRequired: PaymentRequired;
  purchaseLegal: PurchaseLegalContext;
  challenge: StoredChallenge;
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
  if (!(await deps.deploymentReadiness.isReady())) {
    // Readiness refusals must carry their reason — a silent one cost an
    // hour of forensics on 2026-08-01. Stable code; failedCheck in the
    // message and details.
    const { failedCheck } = deps.deploymentReadiness.status();
    const reason = failedCheck ?? "unready";
    logger.warn("x402.readiness_refused", {
      site: "quoted_challenge",
      failedCheck: reason,
    });
    return {
      ok: false,
      error: {
        code: "payment_screening_unready",
        message:
          `Payment cannot be processed right now (${reason}). ` +
          "Please try again later.",
        details: { reason },
        recoverable: true,
        nextAction: "Retry later while payment screening is available.",
      },
    };
  }
  if (!deps.cache.get(input.providerAgentId)) {
    return fail("provider_not_found", "provider is not currently admitted");
  }
  const cachedOffer = resolveSkillOffer(
    input.providerAgentId,
    input.skillId,
    deps.cache,
    { serviceSlug: input.serviceSlug },
  );
  if (!cachedOffer.ok) {
    return fail(cachedOffer.code, cachedOffer.message);
  }
  let authority;
  try {
    authority = await deps.providerAuthority.requireFreshCatalog(
      input.providerAgentId,
    );
  } catch (error) {
    const code =
      error instanceof ProviderAuthorityError
        ? error.code
        : "provider_authority_unavailable";
    return {
      ok: false,
      error: {
        code,
        message:
          code === "provider_inactive"
            ? "provider is not currently active"
            : "provider authority is temporarily unavailable",
        recoverable: code === "provider_authority_unavailable",
        ...(code === "provider_authority_unavailable"
          ? { nextAction: "Retry after the provider registry is readable." }
          : {}),
      },
    };
  }
  const provider = deps.cache.get(input.providerAgentId);
  if (!provider) {
    return fail("provider_not_found", "provider is not currently admitted");
  }
  if (
    isSelfPurchase({
      buyerAgentId: input.buyerAgentId,
      buyerWallet: input.walletAddress,
      providerAgentId: provider.agentId,
      providerWallet: authority.walletAddress,
    })
  ) {
    return fail(
      "self_purchase_not_allowed",
      "A provider cannot purchase its own service.",
    );
  }
  const offerResult = resolveSkillOffer(
    input.providerAgentId,
    input.skillId,
    deps.cache,
    {
      serviceSlug: input.serviceSlug,
    },
  );
  if (!offerResult.ok) {
    return fail(offerResult.code, offerResult.message);
  }
  const offer = offerResult.offer;
  if (
    input.buyerAgentId !== 0n &&
    !(await walletControlsAgent(
      deps.reader,
      input.buyerAgentId,
      input.walletAddress,
    ))
  ) {
    return fail(
      "buyer_agent_not_controlled",
      "walletAddress does not control buyerTokenId",
    );
  }
  const quoteResult = await fetchProviderQuote({
    providerA2AUrl: offer.providerA2AUrl,
    skillId: input.skillId,
    serviceArgs: input.serviceArgs,
    expectedSignerAddress: authority.walletAddress,
    expectedChainId: deps.config.chainId,
    expectedTokenAddress: deps.config.usdc.address,
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
              details: {
                rejectedFields: quoteResult.rejectedFields ?? [],
              },
              recoverable: true,
              nextAction:
                "Review only the rejected fields against the published skill " +
                "schema, correct serviceArgs, and retry.",
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
        },
        recoverable: true,
        nextAction:
          "Review the quoted amount with the principal and retry only with an " +
          "explicitly approved higher amount limit.",
      },
    };
  }

  const quote = quoteResult.quote;
  const issued = await issuePaymentRequirements(
    {
      providerTokenId: input.providerAgentId,
      buyerTokenId: input.buyerAgentId,
      skillId: input.skillId,
      resource: `${deps.config.publicUrl}/purchase/${input.providerAgentId}`,
      walletAddress: input.walletAddress,
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
      requestFingerprint: input.requestFingerprint,
      serviceArgs: input.serviceArgs,
      warnings: input.warnings,
      registrationDelegation: input.registrationDelegation,
      providerAuthority: authority,
    },
    deps.config,
    deps.cache,
    deps.queries,
    deps.reader,
  );
  if (!issued.ok) return fail(issued.code, issued.message);
  return {
    ok: true,
    value: {
      offer,
      requirements: issued.requirements,
      paymentRequired: issued.paymentRequired,
      purchaseLegal: issued.purchaseLegal,
      challenge: issued.challenge,
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
