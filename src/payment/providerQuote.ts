import { a2aPostJson } from "../mcp/a2a.js";
import {
  validateProviderQuoteCommitment,
} from "./providerQuoteValidation.js";
import type {
  FetchProviderQuoteArgs,
  ProviderQuoteCommitment,
  ProviderRejectedField,
  ProviderQuoteResult,
} from "./providerQuoteTypes.js";

export { validateProviderQuoteCommitment } from "./providerQuoteValidation.js";
export {
  PROVIDER_QUOTE_VERSION,
  type FetchProviderQuoteArgs,
  type ProviderQuoteCommitment,
  type ProviderQuoteExpectations,
  type ProviderRejectedField,
  type ProviderQuoteResult,
  type ProviderQuoteValidationResult,
} from "./providerQuoteTypes.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_REJECTED_FIELDS = 20;
const MAX_PROVIDER_MESSAGE_LENGTH = 1_000;
const FIELD_PATH_RE =
  /^[A-Za-z][A-Za-z0-9_]*(?:(?:\.[A-Za-z][A-Za-z0-9_]*)|(?:\[(?:0|[1-9][0-9]{0,3})\]))*$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function quoteUrlFor(providerA2AUrl: string): string {
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
  if (body.ok === false) {
    const rejectedFields = parseRejectedFields(body.errors, args.serviceArgs);
    if (!rejectedFields) {
      return malformed("provider /quote returned malformed validation errors");
    }
    return {
      ok: false,
      code: "quote_validation_failed",
      message: "Provider rejected the requested args.",
      rejectedFields,
    };
  }
  if (body.ok !== true) {
    return malformed("provider /quote returned a malformed ok flag");
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
  return {
    ok: true,
    amount: body.amount,
    quote,
    paymentRequired: body.paymentRequired !== false,
  };
}

interface QuoteJson {
  ok?: boolean;
  amount?: unknown;
  currency?: unknown;
  paymentRequired?: unknown;
  quote?: unknown;
  errors?: unknown;
}

function parseRejectedFields(
  value: unknown,
  serviceArgs: Record<string, unknown>,
): ProviderRejectedField[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_REJECTED_FIELDS
  ) {
    return null;
  }
  const rejectedFields: ProviderRejectedField[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const keys = Object.keys(entry);
    if (
      keys.some((key) => !["field", "code", "message"].includes(key)) ||
      typeof entry.field !== "string" ||
      entry.field.length > 160 ||
      !FIELD_PATH_RE.test(entry.field) ||
      typeof entry.code !== "string" ||
      !ERROR_CODE_RE.test(entry.code) ||
      typeof entry.message !== "string" ||
      entry.message.length > MAX_PROVIDER_MESSAGE_LENGTH
    ) {
      return null;
    }
    const rootField = entry.field.match(/^[A-Za-z][A-Za-z0-9_]*/)?.[0];
    if (!rootField || !Object.hasOwn(serviceArgs, rootField)) return null;
    const key = `${entry.field}:${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rejectedFields.push({ field: entry.field, code: entry.code });
  }
  return rejectedFields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
