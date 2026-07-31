import type { Fetcher } from "../mcp/a2a.js";
import type { Hex } from "../types.js";

export const PROVIDER_QUOTE_VERSION = "provider-quote-v2" as const;

export interface ProviderQuoteCommitment {
  quoteId: string;
  serviceRef: Hex;
  requestHash: Hex;
  // Hash of edge-attested request-country evidence, or null when the
  // provider saw none. Part of the signed payload since provider v0.11.0.
  trustedRequestCountryHash: Hex | null;
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
  // Provider-owned quote-commitment v2 field: the supplier cost ceiling the
  // provider bound into the signed payload (null when the service has no
  // supplier spend). The gateway does not consume it — it must carry the
  // exact value so the canonical signed payload (and serviceRef, its
  // keccak) reconstruct byte-for-byte.
  supplierCostCeiling: Record<string, unknown> | null;
  providerSignature: Hex;
  signerAddress: Hex;
  signingKeyId: string;
}

export type SignedQuotePayload = Omit<
  ProviderQuoteCommitment,
  "serviceRef" | "providerSignature" | "signerAddress" | "signingKeyId"
>;

export interface ProviderQuoteExpectations {
  skillId: string;
  serviceArgs: Record<string, unknown>;
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

export interface ProviderRejectedField {
  field: string;
  code: string;
}

export type ProviderQuoteResult =
  | {
      ok: true;
      amount: string;
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
      rejectedFields?: ProviderRejectedField[];
    };

export interface FetchProviderQuoteArgs {
  providerA2AUrl: string;
  skillId: string;
  serviceArgs: Record<string, unknown>;
  expectedSignerAddress: Hex;
  expectedChainId: number;
  expectedTokenAddress: Hex;
  expectedServiceSlug: string;
  expectedServiceVersion: string;
  fetchFn: Fetcher;
  timeoutMs?: number;
  maxBytes?: number;
}
