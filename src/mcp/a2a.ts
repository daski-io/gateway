import { mcpError, type McpToolResult } from "./util.js";
import {
  readBoundedJson,
  safeFetch,
  UrlSafetyError,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../util/urlSafety.js";

// ── Outbound A2A POST helper ────────────────────────────────────────────
//
// Every provider-bound call in mcp/server.ts used to repeat the same
// 25-line block: validate the URL, build an AbortController, install a
// setTimeout, POST JSON with `redirect: manual`, catch the abort/network
// error, then drain the response with `readBoundedJson` and map any
// UrlSafetyError to PROVIDER_RESPONSE_TOO_LARGE. This helper concentrates
// that boilerplate in one place.
//
// Callers map the returned `reason` to a tool-specific error code so the
// MCP error envelope stays consistent with the surrounding flow (e.g.
// `quote_malformed` vs `provider_unreachable`).

export type Fetcher = (
  url: string,
  init?: RequestInit,
  preValidated?: ValidatedUrl,
) => Promise<Response>;

export type A2APostFailureReason =
  | "url_blocked"
  | "timeout"
  | "unreachable"
  | "http_error"
  | "non_json"
  | "oversized";

export interface A2APostFailure {
  ok: false;
  reason: A2APostFailureReason;
  /** Underlying error message (already stringified). */
  message: string;
  /** Populated when reason === "url_blocked" so callers can include the
   *  safety code in their error details. */
  urlSafetyCode?: string;
  /** Set when the provider replied with a non-2xx status before we could
   *  parse a body. */
  status?: number;
}

export interface A2APostSuccess<T> {
  ok: true;
  status: number;
  body: T;
  raw: Response;
}

export type A2APostResult<T> = A2APostSuccess<T> | A2APostFailure;

export interface A2APostOptions {
  fetch: Fetcher;
  timeoutMs: number;
  /** Hard cap on the response body. Mirrors the per-call limits scattered
   *  across server.ts (`A2A_RESPONSE_MAX_BYTES`). */
  maxBytes: number;
  /** Defaults to `{ "Content-Type": "application/json" }`. Pass extras
   *  (e.g. `Accept: text/event-stream`) to merge. */
  extraHeaders?: Record<string, string>;
  /** When true, treat non-2xx responses as `http_error` failures without
   *  attempting to parse a JSON body. Most callers want false so they can
   *  read provider-supplied error JSON for richer messages. */
  failOnNonOk?: boolean;
}

/**
 * POSTs `jsonBody` to `url` (must pass `validateUrlForOutbound`) and reads
 * the response with `readBoundedJson`. Returns a discriminated result so
 * call sites can map each failure mode to their preferred MCP error code.
 */
export async function a2aPostJson<T>(
  url: string,
  jsonBody: unknown,
  opts: A2APostOptions,
): Promise<A2APostResult<T>> {
  let validated: ValidatedUrl | undefined;
  if (opts.fetch === safeFetch) {
    try {
      validated = await validateUrlForOutbound(url);
    } catch (err) {
      if (err instanceof UrlSafetyError) {
        return {
          ok: false,
          reason: "url_blocked",
          message: err.message,
          urlSafetyCode: err.code,
        };
      }
      throw err;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await opts.fetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.extraHeaders ?? {}),
        },
        body: JSON.stringify(jsonBody),
        signal: controller.signal,
        redirect: "manual",
      },
      validated,
    );
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    const timedOut = e.name === "AbortError";
    return {
      ok: false,
      reason: timedOut ? "timeout" : "unreachable",
      message: timedOut
        ? "provider request timed out"
        : "provider request failed",
    };
  }

  if (opts.failOnNonOk && !res.ok) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: "http_error",
      message: `provider returned HTTP ${res.status}`,
      status: res.status,
    };
  }

  let body: T;
  try {
    body = await readBoundedJson<T>(res, opts.maxBytes);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return {
        ok: false,
        reason: "timeout",
        message: "provider request timed out",
        status: res.status,
      };
    }
    if (err instanceof UrlSafetyError) {
      return {
        ok: false,
        reason:
          err.code === "RESPONSE_TOO_LARGE" ? "oversized" : "non_json",
        message: err.message,
        status: res.status,
      };
    }
    return {
      ok: false,
      reason: "non_json",
      message: `non-JSON body (status ${res.status})`,
      status: res.status,
    };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, status: res.status, body, raw: res };
}

// ── URL-guard MCP envelope ──────────────────────────────────────────────
//
// Translates a `validateUrlForOutbound` failure into the standardized MCP
// error result. Kept in this module so the URL-safety guard, the POST
// wrapper, and the SSE streaming path all use the same envelope shape.

export async function guardProviderUrl(
  url: string,
  enabled = true,
): Promise<McpToolResult | null> {
  if (!enabled) return null;
  try {
    await validateUrlForOutbound(url);
    return null;
  } catch (err) {
    if (err instanceof UrlSafetyError) {
      return mcpError({
        code: "PROVIDER_URL_BLOCKED",
        message: `Provider URL rejected: ${err.message}`,
        details: { reason: err.code },
      });
    }
    throw err;
  }
}

// ── Failure → MCP error mapping ─────────────────────────────────────────
//
// Default translation from `A2APostFailure` to an `McpToolResult` for the
// generic A2A tools (submit/poll/stream). Call sites with bespoke error
// codes (e.g. `daski_buy_service` → quote/availability) construct their
// own envelopes off the failure reason so the agent-facing code stays
// specific.

export interface ProviderErrorMappingOptions {
  /** Echoed into `details.contextId` so the agent can correlate retries. */
  contextId?: string;
  /** Caller-supplied hint shown to the model when the call is retryable. */
  nextAction?: string;
  /** When false, the result omits `recoverable: true` for timeouts. */
  recoverableTimeout?: boolean;
}

export function providerErrorFromFailure(
  failure: A2APostFailure,
  url: string,
  opts: ProviderErrorMappingOptions = {},
): McpToolResult {
  const baseDetails: Record<string, unknown> = { providerA2AUrl: url };
  if (opts.contextId !== undefined) baseDetails.contextId = opts.contextId;
  if (failure.status !== undefined) baseDetails.status = failure.status;

  switch (failure.reason) {
    case "url_blocked":
      return mcpError({
        code: "PROVIDER_URL_BLOCKED",
        message: `Provider URL rejected: ${failure.message}`,
        details: { ...baseDetails, reason: failure.urlSafetyCode },
      });
    case "timeout":
      return mcpError({
        code: "PROVIDER_TIMEOUT",
        message: `Provider unreachable at ${url}`,
        details: baseDetails,
        ...(opts.recoverableTimeout !== false ? { recoverable: true } : {}),
        ...(opts.nextAction ? { next_action: opts.nextAction } : {}),
      });
    case "unreachable":
      return mcpError({
        code: "PROVIDER_UNREACHABLE",
        message: `Provider unreachable at ${url}`,
        details: baseDetails,
        ...(opts.recoverableTimeout !== false ? { recoverable: true } : {}),
        ...(opts.nextAction ? { next_action: opts.nextAction } : {}),
      });
    case "http_error":
      return mcpError({
        code: "PROVIDER_ERROR",
        message: `Provider returned HTTP ${failure.status}`,
        details: baseDetails,
      });
    case "oversized":
      return mcpError({
        code: "PROVIDER_RESPONSE_TOO_LARGE",
        message: failure.message,
        details: baseDetails,
      });
    case "non_json":
      return mcpError({
        code: "PROVIDER_ERROR",
        message: `Provider returned non-JSON (status ${failure.status})`,
        details: baseDetails,
      });
  }
}
