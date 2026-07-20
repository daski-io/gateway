import { a2aPostJson } from "../mcp/a2a.js";
import {
  validateProviderQuoteCommitment,
} from "./providerQuoteValidation.js";
import type {
  FetchProviderQuoteArgs,
  ProviderQuoteCommitment,
  ProviderQuoteResult,
} from "./providerQuoteTypes.js";

export { validateProviderQuoteCommitment } from "./providerQuoteValidation.js";
export {
  PROVIDER_QUOTE_VERSION,
  type FetchProviderQuoteArgs,
  type ProviderQuoteCommitment,
  type ProviderQuoteExpectations,
  type ProviderQuoteResult,
  type ProviderQuoteValidationResult,
} from "./providerQuoteTypes.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export function quoteUrlFor(providerA2AUrl: string): string {
  return providerA2AUrl.replace(/\/a2a(?=\/|$)/, "/quote");
}

export async function fetchProviderQuote(
  args: FetchProviderQuoteArgs,
): Promise<ProviderQuoteResult> {
  const url = quoteUrlFor(args.providerA2AUrl);
  const post = await a2aPostJson<QuoteJson>(
    url,
    { skillId: args.skillId, serviceArgs: args.serviceArgs },
    {
      fetch: args.fetchFn,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: args.maxBytes ?? DEFAULT_MAX_BYTES,
    },
  );
  if (!post.ok) return transportFailure(url, post);
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
    return malformed("provider /quote returned an invalid top-level amount");
  }
  if (body.currency !== undefined && body.currency !== "USDC") {
    return malformed("provider /quote returned an unsupported currency");
  }
  if (
    body.paymentRequired !== undefined &&
    typeof body.paymentRequired !== "boolean"
  ) {
    return malformed("provider /quote returned a malformed paymentRequired flag");
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
      return malformed(
        `provider /quote returned an invalid commitment: ${validated.message}`,
      );
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

interface QuoteJson {
  ok?: boolean;
  amount?: unknown;
  currency?: unknown;
  notes?: unknown;
  paymentRequired?: unknown;
  quote?: unknown;
  errors?: Array<{ field: string; code: string; message: string }>;
}

function malformed(message: string): ProviderQuoteResult {
  return { ok: false, code: "quote_malformed", message };
}

function transportFailure(
  url: string,
  post: Exclude<Awaited<ReturnType<typeof a2aPostJson<QuoteJson>>>, { ok: true }>,
): ProviderQuoteResult {
  if (post.reason === "timeout" || post.reason === "unreachable") {
    return {
      ok: false,
      code: post.reason === "timeout" ? "provider_timeout" : "provider_unreachable",
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
