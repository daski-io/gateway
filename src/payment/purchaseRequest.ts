import type { Response } from "express";
import type { ChainReader } from "../chain/reader.js";
import { X402_VERSION, type Config } from "../config.js";
import type { DiscoveryCache } from "../discovery/cache.js";
import { walletControlsAgent } from "../identity/control.js";
import type { FetchAgentCardOptions } from "../identity/fetch-agent-card.js";
import {
  buildRegistrationTransaction,
  prepareRegistration,
} from "../identity/service.js";
import type { Hex } from "../types.js";
import { isHexAddress } from "../util/evmValidation.js";
import type { ProviderQuoteForChallenge } from "./quoteBinding.js";
import { validateProviderQuoteCommitment } from "./providerQuote.js";
import { resolveSkillOffer } from "./skillOffer.js";
import { isSelfPurchase } from "./selfPurchase.js";

interface PurchaseRequestDeps {
  config: Config;
  cache: DiscoveryCache;
  reader: ChainReader;
  fetchAgentCardFn?: FetchAgentCardOptions["fetchFn"];
}

interface ParsedPurchaseRequest {
  buyerTokenId: bigint;
  walletAddress: Hex;
  skillId: string;
  serviceArgs: Record<string, unknown>;
  providerQuote: ProviderQuoteForChallenge;
  registration?: { agentURI: string; deadline: string; signature: Hex };
}

export async function parsePurchaseRequest(
  deps: PurchaseRequestDeps,
  providerTokenId: bigint,
  body: Record<string, unknown>,
  res: Response,
): Promise<ParsedPurchaseRequest | null> {
  let buyerTokenId: bigint;
  try {
    buyerTokenId = BigInt(String(body.buyerTokenId));
  } catch {
    sendError(res, 400, "buyerTokenId is required as a numeric string");
    return null;
  }
  if (!isHexAddress(body.walletAddress)) {
    sendError(res, 400, "walletAddress is required (20-byte hex)");
    return null;
  }
  const walletAddress = body.walletAddress.toLowerCase() as Hex;
  const skillId = typeof body.skillId === "string" ? body.skillId : "";
  const serviceSlug =
    typeof body.serviceSlug === "string" ? body.serviceSlug : "";
  if (!skillId || !serviceSlug) {
    sendError(res, 400, "skillId and serviceSlug are required");
    return null;
  }
  if (
    buyerTokenId !== 0n &&
    !(await walletControlsAgent(deps.reader, buyerTokenId, walletAddress))
  ) {
    sendError(res, 403, "walletAddress does not control buyerTokenId");
    return null;
  }
  const registration = await parseRegistration(
    deps,
    buyerTokenId,
    walletAddress,
    body,
    res,
  );
  if (registration === null) return null;

  const serviceArgs = isRecord(body.serviceArgs) ? body.serviceArgs : {};
  const provider = deps.cache.get(providerTokenId);
  const offerResult = resolveSkillOffer(providerTokenId, skillId, deps.cache, {
    serviceSlug,
  });
  if (!provider || !offerResult.ok) {
    sendError(
      res,
      offerResult.ok ? 404 : offerResult.status,
      "provider or skill not found",
    );
    return null;
  }
  if (
    isSelfPurchase({
      buyerAgentId: buyerTokenId,
      buyerWallet: walletAddress,
      providerAgentId: provider.agentId,
      providerWallet: provider.walletAddress,
    })
  ) {
    res.status(403).json({
      x402Version: X402_VERSION,
      error: "self_purchase_not_allowed",
      message: "A provider cannot purchase its own service.",
    });
    return null;
  }
  const validation = await validateProviderQuoteCommitment(body.providerQuote, {
    skillId,
    serviceArgs,
    amount:
      isRecord(body.providerQuote) &&
      typeof body.providerQuote.amount === "string"
        ? body.providerQuote.amount
        : "",
    expectedSignerAddress: provider.walletAddress,
    expectedChainId: deps.config.chainId,
    expectedTokenAddress: deps.config.usdcAddress,
    expectedServiceSlug: offerResult.offer.serviceSlug,
    expectedServiceVersion: offerResult.offer.serviceVersion,
  });
  if (!validation.ok) {
    sendError(res, 400, `invalid providerQuote: ${validation.message}`);
    return null;
  }
  if (!withinAmountLimit(validation.quote.amount, body.amount, res)) {
    return null;
  }
  const quote = validation.quote;
  return {
    buyerTokenId,
    walletAddress,
    skillId,
    serviceArgs,
    registration: registration ?? undefined,
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
  };
}

async function parseRegistration(
  deps: PurchaseRequestDeps,
  buyerTokenId: bigint,
  walletAddress: Hex,
  body: Record<string, unknown>,
  res: Response,
): Promise<
  { agentURI: string; deadline: string; signature: Hex } | undefined | null
> {
  if (buyerTokenId !== 0n) return undefined;
  if (!isRecord(body.registration)) {
    const prepared = await prepareRegistration(
      {
        config: deps.config,
        reader: deps.reader,
        fetchAgentCardFn: deps.fetchAgentCardFn,
      },
      { walletAddress, name: body.name, deadlineSeconds: 3600 },
    );
    res.status(prepared.ok ? 409 : prepared.status).json(
      prepared.ok
        ? {
            error: "registration_required",
            registrationPrep: prepared.value,
          }
        : prepared.error,
    );
    return null;
  }
  const checked = await buildRegistrationTransaction(
    {
      config: deps.config,
      reader: deps.reader,
      fetchAgentCardFn: deps.fetchAgentCardFn,
    },
    { walletAddress, ...body.registration },
  );
  if (!checked.ok) {
    res.status(checked.status).json(checked.error);
    return null;
  }
  return {
    agentURI: String(body.registration.agentURI),
    deadline: String(body.registration.deadline),
    signature: String(body.registration.signature) as Hex,
  };
}

function withinAmountLimit(
  quotedAmount: string,
  rawLimit: unknown,
  res: Response,
): boolean {
  if (typeof rawLimit !== "string") return true;
  try {
    if (BigInt(quotedAmount) > BigInt(rawLimit)) {
      sendError(res, 409, "provider quote exceeds amount limit");
      return false;
    }
  } catch {
    sendError(res, 400, "amount must be a decimal string");
    return false;
  }
  return true;
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ x402Version: X402_VERSION, error: message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
