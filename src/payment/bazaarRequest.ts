import type { Request, Response } from "express";
import { computeRequestHash } from "../auth/envelope.js";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { buildPurchaseLegalContext } from "../legal/purchase.js";
import type { PurchaseLegalContext } from "../legal/types.js";
import type { Fetcher } from "../mcp/a2a.js";
import type { Hex, StoredChallenge } from "../types.js";
import type { ExternalFacilitatorClient } from "./externalFacilitator.js";
import { decodeBazaarPayment } from "./bazaarPayment.js";
import { quoteBazaarProvider } from "./bazaarQuote.js";
import { boundedTimeoutSeconds, buildPaymentRequired, serviceArgsFrom } from "./bazaarResponse.js";
import { resolveSkillOffer, type SkillOffer } from "./skillOffer.js";
import type { ProviderQuoteCommitment } from "./providerQuote.js";

export interface BazaarDeps {
  config: Config;
  cache: DiscoveryCache;
  queries: Queries;
  reader: ChainReader;
  facilitator: ExternalFacilitatorClient;
  quoteFetch: Fetcher;
  quoteTimeoutMs?: number;
}

export interface BazaarRequestContext {
  providerTokenId: bigint;
  skillId: string;
  serviceSlug: string;
  paymentHeader: string;
  offer: SkillOffer;
  resourceUrl: string;
  purchaseLegal: PurchaseLegalContext | null;
  serviceArgs: Record<string, unknown>;
  serviceArgsHash: Hex;
}

export async function prepareBazaarRequest(
  req: Request,
  res: Response,
  deps: BazaarDeps,
): Promise<BazaarRequestContext | null> {
  const providerTokenId = parseAgentId(req, res);
  if (providerTokenId === null) return null;
  const skillId = String(req.params.skillId ?? "");
  const serviceSlug = String(req.params.serviceSlug ?? "");
  const paymentHeader =
    req.header("payment-signature") ??
    req.header("payment") ??
    req.header("x-payment");
  const offerResult = await resolveOffer(
    providerTokenId,
    serviceSlug,
    skillId,
    paymentHeader,
    res,
    deps,
  );
  if (!offerResult) return null;

  const resourceUrl =
    `${deps.config.publicUrl}/x402/services/${providerTokenId.toString()}/` +
    `${encodeURIComponent(serviceSlug)}/${encodeURIComponent(skillId)}`;
  const providerLegal = deps.cache.get(providerTokenId)?.providerLegal;
  const purchaseLegal = providerLegal
    ? buildPurchaseLegalContext(deps.config, providerLegal)
    : null;
  if (!purchaseLegal && !offerResult.recoveryChallenge) {
    legalError(res);
    return null;
  }
  const serviceArgs = serviceArgsFrom(req);
  let serviceArgsHash: Hex;
  try {
    serviceArgsHash = computeRequestHash(serviceArgs);
  } catch (error) {
    res.status(400).json({
      x402Version: 2,
      error: `serviceArgs cannot be canonically hashed: ${(error as Error).message}`,
    });
    return null;
  }
  if (!paymentHeader) {
    await sendInitialQuote(
      req,
      res,
      deps,
      offerResult.offer,
      skillId,
      serviceArgs,
      resourceUrl,
      purchaseLegal,
    );
    return null;
  }
  if (req.method === "GET") {
    res.status(405).json({
      x402Version: 2,
      error: "paid requests must use POST with the quoted serviceArgs body",
    });
    return null;
  }
  return {
    providerTokenId,
    skillId,
    serviceSlug,
    paymentHeader,
    offer: offerResult.offer,
    resourceUrl,
    purchaseLegal,
    serviceArgs,
    serviceArgsHash,
  };
}

export async function quoteOrRespond(
  res: Response,
  offer: SkillOffer,
  skillId: string,
  serviceArgs: Record<string, unknown>,
  deps: BazaarDeps,
): Promise<{ amount: bigint; quote: ProviderQuoteCommitment } | null> {
  const result = await quoteBazaarProvider(offer, skillId, serviceArgs, {
    config: deps.config,
    cache: deps.cache,
    fetch: deps.quoteFetch,
    timeoutMs: deps.quoteTimeoutMs,
  });
  if (!result.ok) {
    res.status(result.status).json(result.body);
    return null;
  }
  return { amount: result.amount, quote: result.quote };
}

async function resolveOffer(
  providerTokenId: bigint,
  serviceSlug: string,
  skillId: string,
  paymentHeader: string | undefined,
  res: Response,
  deps: BazaarDeps,
): Promise<{ offer: SkillOffer; recoveryChallenge: StoredChallenge | null } | null> {
  const resolved = resolveSkillOffer(providerTokenId, skillId, deps.cache, {
    serviceSlug,
  });
  if (resolved.ok) return { offer: resolved.offer, recoveryChallenge: null };
  const persisted = paymentHeader
    ? await recoveryChallenge(paymentHeader, deps.queries)
    : null;
  if (
    !persisted ||
    persisted.providerTokenId !== providerTokenId ||
    persisted.serviceSlug !== serviceSlug ||
    persisted.skillId !== skillId
  ) {
    res.status(resolved.status).json({
      x402Version: 2,
      error: `${resolved.code}: ${resolved.message}`,
    });
    return null;
  }
  return {
    recoveryChallenge: persisted,
    offer: {
      providerTokenId: persisted.providerTokenId,
      skillId,
      serviceSlug: persisted.serviceSlug,
      serviceVersion: persisted.serviceVersion,
      serviceId: persisted.serviceId,
      providerA2AUrl: persisted.providerA2AUrl,
      description: `Daski service ${skillId}`,
    },
  };
}

async function recoveryChallenge(
  paymentHeader: string,
  queries: Queries,
): Promise<StoredChallenge | null> {
  const decoded = decodeBazaarPayment(paymentHeader);
  if (!decoded) return null;
  return queries.getChallengeByWalletAndNonce(
    decoded.authorization.from.toLowerCase() as Hex,
    decoded.authorization.nonce.toLowerCase() as Hex,
  );
}

async function sendInitialQuote(
  req: Request,
  res: Response,
  deps: BazaarDeps,
  offer: SkillOffer,
  skillId: string,
  serviceArgs: Record<string, unknown>,
  resourceUrl: string,
  purchaseLegal: PurchaseLegalContext | null,
): Promise<void> {
  if (!purchaseLegal) return legalError(res);
  if (req.method === "GET") {
    res.status(422).json({
      x402Version: 2,
      error:
        "serviceArgs_required: POST this resource with body.serviceArgs " +
        "to obtain an argument-bound signed quote",
    });
    return;
  }
  const quoted = await quoteOrRespond(res, offer, skillId, serviceArgs, deps);
  if (!quoted) return;
  const timeout = boundedTimeoutSeconds(deps.config, quoted.quote);
  if (timeout === null) {
    res.status(409).json({
      x402Version: 2,
      error: "quote_expired: request a fresh provider quote",
    });
    return;
  }
  res.status(402).json(
    buildPaymentRequired(
      offer,
      quoted.amount,
      deps.config,
      resourceUrl,
      timeout,
      purchaseLegal,
      quoted.quote,
    ),
  );
}

function parseAgentId(req: Request, res: Response): bigint | null {
  try {
    return BigInt(String(req.params.agentId));
  } catch {
    res.status(404).json({ x402Version: 2, error: "invalid provider token id" });
    return null;
  }
}

function legalError(res: Response): void {
  res.status(422).json({
    x402Version: 2,
    error:
      "provider_legal_metadata_invalid: provider legal metadata is missing or invalid",
  });
}
