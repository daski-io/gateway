import type { Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import {
  extractAgentCardUrl,
  extractMarketplaceExtension,
  findCardForSkill,
} from "../discovery/agentCard.js";
import type { Queries } from "../db/queries.js";
import type {
  Hex,
  PaymentRequirements,
  StoredChallenge,
} from "../types.js";
import { buildPurchaseLegalContext } from "../legal/purchase.js";
import {
  computeServiceId,
  resolveServiceSlug,
  resolveServiceVersion,
} from "../discovery/serviceIdentity.js";
import {
  findSkillMetaForPricing,
  providerLegalAdmissionFailure,
} from "./skillOffer.js";
import { claimPaymentChallenge } from "./challengeStore.js";
import { buildRequirementResponse } from "./requirementResponse.js";
import {
  validateQuoteBinding,
  type ProviderQuoteForChallenge,
} from "./quoteBinding.js";

export interface IssueParams {
  providerTokenId: bigint;
  buyerTokenId: bigint;
  skillId: string;
  resource: string;
  /**
   * The wallet address that will sign the EIP-3009 authorization. Required
   * because the gateway bakes it into the typed-data `from` field so the
   * wallet can sign verbatim. The signature must recover to this address
   * at /settle time.
   */
  walletAddress: Hex;
  /**
   * Signed provider quote commitment (provider audit 1.1) from
   * POST /quote/:slug. The challenge settles under the
   * QUOTE's serviceRef — `keccak256(canonicalJson(signedQuotePayload))` —
   * instead of a gateway-generated one, `amount` must equal the quoted
   * amount, and the challenge (plus the EIP-3009 validBefore) is bounded
   * by the quote's expiry. quoteId + providerSignature are persisted and
   * later forwarded as A2A metadata at task-submit time; the provider
   * rejects paid tasks without them.
   */
  providerQuote: ProviderQuoteForChallenge;
}

export type IssueResult =
  | { ok: true; requirements: PaymentRequirements; challenge: StoredChallenge }
  | { ok: false; code: string; message: string; status: number };

export async function issuePaymentRequirements(
  params: IssueParams,
  config: Config,
  cache: DiscoveryCache,
  queries: Queries,
  now: Date = new Date(),
): Promise<IssueResult> {
  const provider = cache.get(params.providerTokenId);
  if (!provider) {
    return {
      ok: false,
      code: "provider_not_found",
      message: "provider is not whitelisted",
      status: 404,
    };
  }
  if (!provider.providerLegal) {
    return providerLegalAdmissionFailure(provider);
  }
  const purchaseLegal = buildPurchaseLegalContext(config, provider.providerLegal);

  // Multi-service providers: everything below (pricing extension, A2A
  // endpoint, serviceSlug/serviceId derivation) must come from the CARD
  // that offers the requested skill.
  const agentCard = findCardForSkill(
    provider,
    params.skillId,
    params.providerQuote.serviceSlug,
  );
  if (!agentCard) {
    return {
      ok: false,
      code: "skill_not_found",
      message: "skillId does not identify a skill in the provider catalog",
      status: 404,
    };
  }

  const ext = extractMarketplaceExtension(agentCard);
  const providerA2AUrl = extractAgentCardUrl(agentCard);
  if (!ext) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card has no Daski marketplace extension",
      status: 422,
    };
  }
  if (!providerA2AUrl) {
    return {
      ok: false,
      code: "pricing_unavailable",
      message: "provider agent card is missing url",
      status: 422,
    };
  }

  // Guard: if the skillId points at a free (ownership-gated) skill, we
  // must NOT issue PaymentRequirements — a fresh payment would be real
  // on-chain USDC burned for nothing, because the provider's A2A handler
  // dispatches free skills via handleFreeSkill and refuses them in the
  // paid-skill path. Agents hit this when they mistake a free skill
  // (set-dns-record, list-dns-records) for a paid one.
  if (params.skillId) {
    const skillMeta = findSkillMetaForPricing(agentCard, params.skillId);
    if (skillMeta && skillMeta["paymentRequired"] === false) {
      return {
        ok: false,
        code: "skill_is_free",
        message:
          `Skill '${params.skillId}' is free (ownership-gated). Do not ` +
          `issue a new payment. Reuse the paymentId from the original ` +
          `asset purchase (e.g. register-domain) and call daski_submit_task ` +
          `directly. If requiresCapability is set, the first authenticated ` +
          `submission returns an in-band EIP-712 capability challenge to sign.`,
        status: 400,
      };
    }
  }

  const quote = params.providerQuote;
  // Every paid settle binds to a ServiceRegistry row. The provider card
  // must declare the on-chain serviceSlug for the selected skill.
  const skillId = params.skillId;
  if (!skillId || skillId.length === 0 || skillId.length > 64) {
    return {
      ok: false,
      code: "skill_id_required",
      message:
        "skillId is required and must be 1–64 bytes — every payment is " +
        "bound to a specific service in ServiceRegistry. Pass the " +
        "AgentSkill.id from the provider's Agent Card.",
      status: 400,
    };
  }
  const serviceSlug = resolveServiceSlug(agentCard, skillId);
  if (!serviceSlug) {
    return {
      ok: false,
      code: "bad_service_slug",
      message:
        "skill metadata must declare a 1–64 byte serviceSlug in the Daski extension.",
      status: 400,
    };
  }
  const serviceVersion = resolveServiceVersion(agentCard, skillId);
  const serviceId = computeServiceId(
    params.providerTokenId,
    serviceSlug,
    serviceVersion,
  );

  const validatedQuote = validateQuoteBinding(
    quote,
    skillId,
    serviceSlug,
    serviceVersion,
    now,
  );
  if (!validatedQuote.ok) return validatedQuote;
  const amount = validatedQuote.amount;
  const serviceRef = quote.serviceRef;
  // Quote-backed challenges live exactly as long as the quote: settling
  // an authorization after quote expiry would capture funds the provider
  // then refuses to fulfill.
  const expiresAt = new Date(
    Math.min(
      now.getTime() + config.challengeTtlSeconds * 1000,
      quote ? quote.expiresAt.getTime() : Number.POSITIVE_INFINITY,
    ),
  );

  const claimed = await claimPaymentChallenge(
    {
      serviceRef,
      providerTokenId: params.providerTokenId,
      buyerTokenId: params.buyerTokenId,
      amount,
      skillId,
      serviceSlug,
      serviceVersion,
      serviceId,
      providerA2AUrl,
      walletAddress: params.walletAddress,
      expiresAt,
      quote: {
        quoteId: quote.quoteId,
        providerSignature: quote.providerSignature,
        expiresAt: quote.expiresAt,
        requestHash: quote.requestHash,
      },
    },
    queries,
    now,
  );
  if (!claimed.ok) return claimed;
  const existingChallenge = claimed.existingChallenge;

  const effectiveExpiresAt = existingChallenge?.expiresAt ?? expiresAt;
  const response = buildRequirementResponse({
    config,
    providerTokenId: params.providerTokenId,
    buyerTokenId: params.buyerTokenId,
    skillId,
    resource: params.resource,
    walletAddress: params.walletAddress,
    amount,
    serviceSlug,
    serviceVersion,
    serviceId,
    serviceRef,
    providerA2AUrl,
    agentCard,
    marketplaceExtension: ext,
    quote,
    purchaseLegal,
    effectiveExpiresAt,
    existingChallenge,
    now,
  });

  return { ok: true, ...response };
}
