import type { Hex } from "../types.js";

export interface ProviderQuoteForChallenge {
  quoteId: string;
  serviceRef: Hex;
  requestHash: Hex;
  providerSignature: Hex;
  amount: string;
  expiresAt: Date;
  skillId: string;
  serviceSlug: string;
  serviceVersion: string;
}

type QuoteBindingResult =
  | { ok: true; amount: bigint }
  | { ok: false; code: string; message: string; status: number };

/** Validates that the signed quote still matches the current Agent Card. */
export function validateQuoteBinding(
  quote: ProviderQuoteForChallenge,
  skillId: string,
  serviceSlug: string,
  serviceVersion: string,
  now: Date,
): QuoteBindingResult {
  let amount: bigint;
  try {
    amount = BigInt(quote.amount);
  } catch {
    return {
      ok: false,
      code: "invalid_quote",
      message: "provider quote amount must be a numeric string",
      status: 400,
    };
  }
  if (amount <= 0n) {
    return {
      ok: false,
      code: "invalid_quote",
      message: "provider quote amount must be greater than zero",
      status: 400,
    };
  }
  if (quote.skillId !== skillId) {
    return {
      ok: false,
      code: "quote_binding_mismatch",
      message: `provider quote is for skill '${quote.skillId}', not '${skillId}'`,
      status: 409,
    };
  }
  if (quote.serviceSlug !== serviceSlug) {
    return {
      ok: false,
      code: "quote_binding_mismatch",
      message:
        `provider quote is for serviceSlug '${quote.serviceSlug}' but the ` +
        `agent card resolves '${skillId}' to '${serviceSlug}' — provider ` +
        "catalog and Agent Card have drifted",
      status: 409,
    };
  }
  if (quote.serviceVersion !== serviceVersion) {
    return {
      ok: false,
      code: "quote_binding_mismatch",
      message:
        `provider quote is for serviceVersion '${quote.serviceVersion}' but ` +
        `the agent card resolves '${skillId}' to '${serviceVersion}'`,
      status: 409,
    };
  }
  if (quote.expiresAt.getTime() <= now.getTime() + 15_000) {
    return {
      ok: false,
      code: "quote_expired",
      message:
        "provider quote is expired (or expires in <15s). Re-quote and " +
        "retry — provider quotes are short-lived (~120s).",
      status: 409,
    };
  }
  return { ok: true, amount };
}
