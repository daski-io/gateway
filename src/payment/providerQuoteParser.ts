import type { Hex } from "../types.js";
import {
  isHex32,
  isHexAddress,
  isHexSignature,
} from "../util/evmValidation.js";
import {
  PROVIDER_QUOTE_VERSION,
  type ProviderQuoteCommitment,
} from "./providerQuoteTypes.js";

export type ParsedProviderQuote =
  | {
      ok: true;
      quote: ProviderQuoteCommitment;
      issuedAtMs: number;
      expiresAtMs: number;
    }
  | { ok: false; message: string };

export function parseProviderQuote(raw: unknown): ParsedProviderQuote {
  if (!isRecord(raw)) return invalid("quote must be an object");
  const required = [
    ["quoteId", raw.quoteId],
    ["serviceId", raw.serviceId],
    ["serviceSlug", raw.serviceSlug],
    ["serviceVersion", raw.serviceVersion],
    ["skillId", raw.skillId],
  ] as const;
  for (const [name, value] of required) {
    if (typeof value !== "string" || value.length === 0) {
      return invalid(`${name} must be a non-empty string`);
    }
  }
  if (!isHex32(raw.requestHash)) {
    return invalid("requestHash must be a 32-byte hex value");
  }
  if (!isHex32(raw.serviceRef)) {
    return invalid("serviceRef must be a 32-byte hex value");
  }
  if (!isPositiveAtomicAmount(raw.amount)) {
    return invalid("quote amount must be a positive atomic-unit integer");
  }
  if (!isHexAddress(raw.token)) {
    return invalid("quote token must be a 20-byte address");
  }
  if (
    typeof raw.chainId !== "number" ||
    !Number.isSafeInteger(raw.chainId) ||
    raw.chainId <= 0
  ) {
    return invalid("quote chainId must be a positive safe integer");
  }
  if (raw.quoteVersion !== PROVIDER_QUOTE_VERSION) {
    return invalid(`quoteVersion must be '${PROVIDER_QUOTE_VERSION}'`);
  }
  if (!isHexSignature(raw.providerSignature)) {
    return invalid("providerSignature must be a 65-byte hex signature");
  }
  if (!isHexAddress(raw.signerAddress)) {
    return invalid("signerAddress must be a 20-byte address");
  }
  if (typeof raw.signingKeyId !== "string" || raw.signingKeyId.length === 0) {
    return invalid("signingKeyId must be a non-empty string");
  }
  const issuedAtMs = timestampMs(raw.issuedAt);
  const expiresAtMs = timestampMs(raw.expiresAt);
  if (issuedAtMs === null || expiresAtMs === null) {
    return invalid("issuedAt and expiresAt must be canonical ISO timestamps");
  }
  if (expiresAtMs <= issuedAtMs) {
    return invalid("expiresAt must be later than issuedAt");
  }

  return {
    ok: true,
    issuedAtMs,
    expiresAtMs,
    quote: {
      quoteId: raw.quoteId as string,
      serviceRef: raw.serviceRef.toLowerCase() as Hex,
      requestHash: raw.requestHash.toLowerCase() as Hex,
      amount: raw.amount,
      token: raw.token.toLowerCase() as Hex,
      chainId: raw.chainId,
      quoteVersion: raw.quoteVersion,
      issuedAt: raw.issuedAt as string,
      expiresAt: raw.expiresAt as string,
      serviceId: raw.serviceId as string,
      serviceSlug: raw.serviceSlug as string,
      serviceVersion: raw.serviceVersion as string,
      skillId: raw.skillId as string,
      providerSignature: raw.providerSignature,
      signerAddress: raw.signerAddress.toLowerCase() as Hex,
      signingKeyId: raw.signingKeyId,
    },
  };
}

export function isPositiveAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return null;
  }
  return parsed;
}

function invalid(message: string): ParsedProviderQuote {
  return { ok: false, message };
}
