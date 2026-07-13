import {
  keccak256,
  toBytes,
  verifyMessage,
  type Address,
} from "viem";
import { computeRequestHash, canonicalJsonStringify } from "../auth/envelope.js";
import { a2aPostJson, type Fetcher } from "../mcp/a2a.js";
import type { Hex } from "../types.js";

/** Version of the canonical payload signed by the provider. */
export const PROVIDER_QUOTE_VERSION = "provider-quote-v1" as const;

/**
 * Provider-issued commitment returned by POST /quote/:serviceSlug.
 *
 * `providerSignature` is an EIP-191 signature over the canonical JSON of
 * all fields except serviceRef and the three signer metadata fields.
 * `serviceRef` is the keccak256 hash of those same canonical JSON bytes.
 */
export interface ProviderQuoteCommitment {
  quoteId: string;
  serviceRef: Hex;
  requestHash: Hex;
  amount: string;
  token: Hex;
  chainId: number;
  quoteVersion: typeof PROVIDER_QUOTE_VERSION;
  issuedAt: string;
  expiresAt: string;
  serviceId: string;
  serviceSlug: string;
  serviceVersion: string;
  skillId: string;
  providerSignature: Hex;
  signerAddress: Hex;
  signingKeyId: string;
}

interface SignedQuotePayload {
  quoteId: string;
  serviceId: string;
  serviceSlug: string;
  serviceVersion: string;
  skillId: string;
  requestHash: Hex;
  amount: string;
  token: Hex;
  chainId: number;
  quoteVersion: typeof PROVIDER_QUOTE_VERSION;
  issuedAt: string;
  expiresAt: string;
}

export interface ProviderQuoteExpectations {
  skillId: string;
  serviceArgs: Record<string, unknown>;
  /** The amount from the top-level /quote response. */
  amount: string;
  expectedSignerAddress: Hex;
  expectedChainId: number;
  expectedTokenAddress: Hex;
  expectedServiceSlug: string;
  expectedServiceVersion: string;
  now?: Date;
}

export type ProviderQuoteValidationResult =
  | { ok: true; quote: ProviderQuoteCommitment }
  | { ok: false; message: string };

export type ProviderQuoteResult =
  | {
      ok: true;
      /** Authoritative amount in atomic USDC — quote == charge. */
      amount: string;
      notes: string[];
      /** Null only for free or pre-commitment provider responses. */
      quote: ProviderQuoteCommitment | null;
      paymentRequired: boolean;
    }
  | {
      ok: false;
      code:
        | "provider_timeout"
        | "provider_unreachable"
        | "quote_malformed"
        | "quote_validation_failed"
        | "quote_unavailable";
      message: string;
      status?: number;
      errors?: Array<{ field: string; code: string; message: string }>;
    };

/**
 * The A2A URL convention is `<base>/a2a[/<slug>]`; /quote mirrors that
 * shape, so we swap the segment in place.
 */
export function quoteUrlFor(providerA2AUrl: string): string {
  return providerA2AUrl.replace(/\/a2a(?=\/|$)/, "/quote");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isSignature(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
}

function isPositiveAtomicAmount(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return null;
  }
  return parsed;
}

function invalid(message: string): ProviderQuoteValidationResult {
  return { ok: false, message };
}

/**
 * Verifies the complete provider quote before the gateway creates a payment
 * challenge. This prevents malformed, substituted, or incorrectly signed
 * commitments from reaching a path where buyer funds can be captured.
 */
export async function validateProviderQuoteCommitment(
  raw: unknown,
  expectations: ProviderQuoteExpectations,
): Promise<ProviderQuoteValidationResult> {
  if (!isRecord(raw)) return invalid("quote must be an object");
  if (!isAddress(expectations.expectedSignerAddress)) {
    return invalid("expected provider signer is not a 20-byte address");
  }
  if (!isAddress(expectations.expectedTokenAddress)) {
    return invalid("expected token is not a 20-byte address");
  }

  const quoteId = raw.quoteId;
  const serviceId = raw.serviceId;
  const serviceSlug = raw.serviceSlug;
  const serviceVersion = raw.serviceVersion;
  const skillId = raw.skillId;
  const amount = raw.amount;
  const chainId = raw.chainId;
  const quoteVersion = raw.quoteVersion;
  const issuedAt = raw.issuedAt;
  const expiresAt = raw.expiresAt;
  const signingKeyId = raw.signingKeyId;

  if (typeof quoteId !== "string" || quoteId.length === 0) {
    return invalid("quoteId must be a non-empty string");
  }
  if (typeof serviceId !== "string" || serviceId.length === 0) {
    return invalid("serviceId must be a non-empty string");
  }
  if (typeof serviceSlug !== "string" || serviceSlug.length === 0) {
    return invalid("serviceSlug must be a non-empty string");
  }
  if (typeof serviceVersion !== "string" || serviceVersion.length === 0) {
    return invalid("serviceVersion must be a non-empty string");
  }
  if (typeof skillId !== "string" || skillId.length === 0) {
    return invalid("skillId must be a non-empty string");
  }
  if (!isBytes32(raw.requestHash)) {
    return invalid("requestHash must be a 32-byte hex value");
  }
  if (!isBytes32(raw.serviceRef)) {
    return invalid("serviceRef must be a 32-byte hex value");
  }
  if (!isPositiveAtomicAmount(amount)) {
    return invalid("quote amount must be a positive atomic-unit integer");
  }
  if (!isAddress(raw.token)) {
    return invalid("quote token must be a 20-byte address");
  }
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return invalid("quote chainId must be a positive safe integer");
  }
  if (quoteVersion !== PROVIDER_QUOTE_VERSION) {
    return invalid(`quoteVersion must be '${PROVIDER_QUOTE_VERSION}'`);
  }
  if (!isSignature(raw.providerSignature)) {
    return invalid("providerSignature must be a 65-byte hex signature");
  }
  if (!isAddress(raw.signerAddress)) {
    return invalid("signerAddress must be a 20-byte address");
  }
  if (typeof signingKeyId !== "string" || signingKeyId.length === 0) {
    return invalid("signingKeyId must be a non-empty string");
  }

  if (typeof issuedAt !== "string" || typeof expiresAt !== "string") {
    return invalid("issuedAt and expiresAt must be canonical ISO timestamps");
  }
  const issuedAtMs = timestampMs(issuedAt);
  const expiresAtMs = timestampMs(expiresAt);
  if (issuedAtMs === null || expiresAtMs === null) {
    return invalid("issuedAt and expiresAt must be canonical ISO timestamps");
  }
  if (expiresAtMs <= issuedAtMs) {
    return invalid("expiresAt must be later than issuedAt");
  }
  if (expiresAtMs <= (expectations.now ?? new Date()).getTime()) {
    return invalid("provider quote has expired");
  }

  if (!isPositiveAtomicAmount(expectations.amount) || amount !== expectations.amount) {
    return invalid("quote amount does not match the top-level response amount");
  }
  if (skillId !== expectations.skillId) {
    return invalid("quote skillId does not match the requested skill");
  }
  if (serviceSlug !== expectations.expectedServiceSlug) {
    return invalid("quote serviceSlug does not match the resolved service");
  }
  if (serviceVersion !== expectations.expectedServiceVersion) {
    return invalid("quote serviceVersion does not match the resolved service");
  }
  if (chainId !== expectations.expectedChainId) {
    return invalid("quote chainId does not match the gateway network");
  }
  if (raw.token.toLowerCase() !== expectations.expectedTokenAddress.toLowerCase()) {
    return invalid("quote token does not match the configured payment token");
  }

  let expectedRequestHash: Hex;
  try {
    expectedRequestHash = computeRequestHash(expectations.serviceArgs);
  } catch (error) {
    return invalid(
      `serviceArgs cannot be canonicalized: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
  if (raw.requestHash.toLowerCase() !== expectedRequestHash.toLowerCase()) {
    return invalid("quote requestHash does not match the requested serviceArgs");
  }

  const payload: SignedQuotePayload = {
    quoteId,
    serviceId,
    serviceSlug,
    serviceVersion,
    skillId,
    requestHash: raw.requestHash.toLowerCase() as Hex,
    amount,
    // Provider signs its configured token address lowercased even though
    // the response wrapper may echo a checksummed config value.
    token: raw.token.toLowerCase() as Hex,
    chainId,
    quoteVersion,
    issuedAt,
    expiresAt,
  };
  let message: string;
  try {
    message = canonicalJsonStringify(payload);
  } catch (error) {
    return invalid(
      `signed quote payload cannot be canonicalized: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
  const expectedRef = keccak256(toBytes(message));
  if (raw.serviceRef.toLowerCase() !== expectedRef.toLowerCase()) {
    return invalid("serviceRef does not hash to the canonical signed quote payload");
  }

  const expectedSigner = expectations.expectedSignerAddress.toLowerCase();
  if (raw.signerAddress.toLowerCase() !== expectedSigner) {
    return invalid("quote signerAddress does not match the provider wallet");
  }
  if (signingKeyId !== `provider-wallet-v1:${expectedSigner}`) {
    return invalid("quote signingKeyId does not match the provider wallet");
  }
  try {
    const signatureValid = await verifyMessage({
      address: expectedSigner as Address,
      message,
      signature: raw.providerSignature,
    });
    if (!signatureValid) {
      return invalid("provider quote signature is invalid");
    }
  } catch {
    return invalid("provider quote signature is invalid");
  }

  return {
    ok: true,
    quote: {
      quoteId,
      serviceRef: raw.serviceRef.toLowerCase() as Hex,
      requestHash: raw.requestHash.toLowerCase() as Hex,
      amount,
      token: raw.token.toLowerCase() as Hex,
      chainId,
      quoteVersion,
      issuedAt,
      expiresAt,
      serviceId,
      serviceSlug,
      serviceVersion,
      skillId,
      providerSignature: raw.providerSignature,
      signerAddress: expectedSigner as Hex,
      signingKeyId,
    },
  };
}

export interface FetchProviderQuoteArgs {
  providerA2AUrl: string;
  skillId: string;
  serviceArgs: Record<string, unknown>;
  expectedSignerAddress: Hex;
  expectedChainId: number;
  expectedTokenAddress: Hex;
  expectedServiceSlug: string;
  expectedServiceVersion: string;
  fetchFn?: Fetcher;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export async function fetchProviderQuote(
  args: FetchProviderQuoteArgs,
): Promise<ProviderQuoteResult> {
  const url = quoteUrlFor(args.providerA2AUrl);
  type QuoteJson = {
    ok?: boolean;
    amount?: unknown;
    currency?: unknown;
    notes?: unknown;
    paymentRequired?: unknown;
    quote?: unknown;
    errors?: Array<{ field: string; code: string; message: string }>;
  };
  const post = await a2aPostJson<QuoteJson>(
    url,
    { skillId: args.skillId, serviceArgs: args.serviceArgs },
    {
      fetch: args.fetchFn ?? (globalThis.fetch as Fetcher),
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES,
    },
  );
  if (!post.ok) {
    if (post.reason === "timeout") {
      return {
        ok: false,
        code: "provider_timeout",
        message: `quote at ${url} failed: ${post.message}`,
      };
    }
    if (post.reason === "unreachable") {
      return {
        ok: false,
        code: "provider_unreachable",
        message: `quote at ${url} failed: ${post.message}`,
      };
    }
    if (post.reason === "non_json") {
      return {
        ok: false,
        code: "quote_malformed",
        message: `provider /quote returned non-JSON (status ${post.status})`,
        status: post.status,
      };
    }
    return {
      ok: false,
      code: "quote_unavailable",
      message: `quote at ${url} failed (status ${post.status})`,
      status: post.status,
    };
  }

  const body = post.body;
  if (!body.ok) {
    return {
      ok: false,
      code: "quote_validation_failed",
      message: "Provider rejected the requested args.",
      errors: Array.isArray(body.errors) ? body.errors : [],
    };
  }
  if (
    typeof body.amount !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(body.amount)
  ) {
    return {
      ok: false,
      code: "quote_malformed",
      message: "provider /quote returned an invalid top-level amount",
    };
  }
  if (body.currency !== undefined && body.currency !== "USDC") {
    return {
      ok: false,
      code: "quote_malformed",
      message: "provider /quote returned an unsupported currency",
    };
  }
  if (
    body.paymentRequired !== undefined &&
    typeof body.paymentRequired !== "boolean"
  ) {
    return {
      ok: false,
      code: "quote_malformed",
      message: "provider /quote returned a malformed paymentRequired flag",
    };
  }

  let quote: ProviderQuoteCommitment | null = null;
  if (body.quote !== undefined && body.quote !== null) {
    const validated = await validateProviderQuoteCommitment(body.quote, {
      skillId: args.skillId,
      serviceArgs: args.serviceArgs,
      amount: body.amount,
      expectedSignerAddress: args.expectedSignerAddress,
      expectedChainId: args.expectedChainId,
      expectedTokenAddress: args.expectedTokenAddress,
      expectedServiceSlug: args.expectedServiceSlug,
      expectedServiceVersion: args.expectedServiceVersion,
    });
    if (!validated.ok) {
      return {
        ok: false,
        code: "quote_malformed",
        message: `provider /quote returned an invalid commitment: ${validated.message}`,
      };
    }
    quote = validated.quote;
  }

  const notes = Array.isArray(body.notes)
    ? body.notes.filter((note): note is string => typeof note === "string")
    : [];
  return {
    ok: true,
    amount: body.amount,
    notes,
    quote,
    paymentRequired: body.paymentRequired !== false,
  };
}
