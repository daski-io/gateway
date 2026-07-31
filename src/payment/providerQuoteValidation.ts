import { keccak256, toBytes, verifyMessage, type Address } from "viem";
import { canonicalJsonStringify, computeRequestHash } from "../auth/envelope.js";
import type { Hex } from "../types.js";
import { isHexAddress } from "../util/evmValidation.js";
import {
  isPositiveAtomicAmount,
  parseProviderQuote,
} from "./providerQuoteParser.js";
import type {
  ProviderQuoteCommitment,
  ProviderQuoteExpectations,
  ProviderQuoteValidationResult,
  SignedQuotePayload,
} from "./providerQuoteTypes.js";

export async function validateProviderQuoteCommitment(
  raw: unknown,
  expectations: ProviderQuoteExpectations,
): Promise<ProviderQuoteValidationResult> {
  if (!isHexAddress(expectations.expectedSignerAddress)) {
    return invalid("expected provider signer is not a 20-byte address");
  }
  if (!isHexAddress(expectations.expectedTokenAddress)) {
    return invalid("expected token is not a 20-byte address");
  }
  const parsed = parseProviderQuote(raw);
  if (!parsed.ok) return parsed;
  const quote = parsed.quote;
  if (parsed.expiresAtMs <= (expectations.now ?? new Date()).getTime()) {
    return invalid("provider quote has expired");
  }
  if (
    !isPositiveAtomicAmount(expectations.amount) ||
    quote.amount !== expectations.amount
  ) {
    return invalid("quote amount does not match the top-level response amount");
  }
  const bindingError = validateBinding(quote, expectations);
  if (bindingError) return invalid(bindingError);

  let expectedRequestHash: Hex;
  try {
    expectedRequestHash = computeRequestHash(expectations.serviceArgs);
  } catch (error) {
    return invalid(
      `serviceArgs cannot be canonicalized: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
  if (quote.requestHash !== expectedRequestHash.toLowerCase()) {
    return invalid("quote requestHash does not match the requested serviceArgs");
  }

  const payload: SignedQuotePayload = {
    quoteId: quote.quoteId,
    serviceId: quote.serviceId,
    serviceSlug: quote.serviceSlug,
    serviceVersion: quote.serviceVersion,
    skillId: quote.skillId,
    requestHash: quote.requestHash,
    trustedRequestCountryHash: quote.trustedRequestCountryHash,
    amount: quote.amount,
    token: quote.token,
    chainId: quote.chainId,
    quoteVersion: quote.quoteVersion,
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    supplierCostCeiling: quote.supplierCostCeiling,
  };
  let message: string;
  try {
    message = canonicalJsonStringify(payload);
  } catch (error) {
    return invalid(
      `signed quote payload cannot be canonicalized: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
  if (quote.serviceRef !== keccak256(toBytes(message)).toLowerCase()) {
    return invalid("serviceRef does not hash to the canonical signed quote payload");
  }
  const expectedSigner = expectations.expectedSignerAddress.toLowerCase();
  if (quote.signerAddress !== expectedSigner) {
    return invalid("quote signerAddress does not match the provider wallet");
  }
  if (quote.signingKeyId !== `provider-wallet-v1:${expectedSigner}`) {
    return invalid("quote signingKeyId does not match the provider wallet");
  }
  try {
    const valid = await verifyMessage({
      address: expectedSigner as Address,
      message,
      signature: quote.providerSignature,
    });
    if (!valid) return invalid("provider quote signature is invalid");
  } catch {
    return invalid("provider quote signature is invalid");
  }
  return { ok: true, quote };
}

function validateBinding(
  quote: ProviderQuoteCommitment,
  expected: ProviderQuoteExpectations,
): string | null {
  if (quote.skillId !== expected.skillId) {
    return "quote skillId does not match the requested skill";
  }
  if (quote.serviceSlug !== expected.expectedServiceSlug) {
    return "quote serviceSlug does not match the resolved service";
  }
  if (quote.serviceVersion !== expected.expectedServiceVersion) {
    return "quote serviceVersion does not match the resolved service";
  }
  if (quote.chainId !== expected.expectedChainId) {
    return "quote chainId does not match the gateway network";
  }
  if (quote.token !== expected.expectedTokenAddress.toLowerCase()) {
    return "quote token does not match the configured payment token";
  }
  return null;
}

function invalid(message: string): ProviderQuoteValidationResult {
  return { ok: false, message };
}
