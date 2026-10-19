import { logger } from "../util/logger.js";
import { classifyRpcFailure, type RpcFailure } from "./classification.js";
import {
  beginRpcAttempt,
  isRpcEndpointOpen,
  planRpcEndpoints,
  releaseRpcPlan,
  type RpcDeferral,
} from "./endpointHealth.js";

export interface RpcEndpoint<Client> {
  host: string;
  client: Client;
  /** Health registry key, shared by every client of this URL. Never logged. */
  url?: string;
}

export interface RpcFallbackDetail {
  primaryHost: string;
  selectedHost: string;
  /** The observation, e.g. `marketplace.getProvider`. */
  operation: string;
  /** Why the primary did not serve: its failure in this observation, or its breaker state. */
  reason: string;
  /** Fallback selections of this operation not reported since the previous report. */
  suppressed: number;
}

interface RpcFailoverOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Label of the observation for logs; defaults to `rpc`. */
  operation?: string;
  /**
   * Reports a non-primary endpoint serving the observation, at most once a
   * minute per operation, endpoint and reason. Without it the failover logs
   * the selection itself.
   */
  onFallback?: (detail: RpcFallbackDetail) => void;
  // A terminal error is the chain's answer (for example a deterministic
  // contract revert), not an endpoint fault: it is rethrown as-is, with no
  // retry, no failover, and no aggregate wrapping.
  terminal?: (error: unknown) => boolean;
}

/** Longest requested Retry-After this observation waits for in line. */
const MAX_INLINE_RETRY_AFTER_MS = 10_000;
const LOG_INTERVAL_MS = 60_000;
const MAX_LOG_KEYS = 256;

const logWindows = new Map<string, { at: number; suppressed: number }>();

/** Returns the suppressed count when the key may log now, else null. */
function throttle(key: string, now = Date.now()): number | null {
  const entry = logWindows.get(key);
  if (entry && now - entry.at < LOG_INTERVAL_MS) {
    entry.suppressed += 1;
    return null;
  }
  if (!entry && logWindows.size >= MAX_LOG_KEYS) logWindows.clear();
  logWindows.set(key, { at: now, suppressed: 0 });
  return entry?.suppressed ?? 0;
}

/** Forgets log throttling windows (tests). */
export function resetRpcFailoverLogThrottle(): void {
  logWindows.clear();
}

function failureSummary(host: string, attempts: number, error: unknown, failure?: RpcFailure): Error {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = failure?.code ?? (typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined);
  return new Error(
    host + " RPC observation failed after " + attempts + " attempts (" +
      name + (code !== undefined && code !== null ? " " + String(code) : "") +
      (failure && failure.kind !== "unclassified" ? ", " + failure.reason : "") + ")",
  );
}

function logEndpointFailure(args: {
  host: string;
  role: "primary" | "fallback";
  operation: string;
  attempt: number;
  latencyMs: number;
  failure: RpcFailure;
}): void {
  const { failure } = args;
  const suppressed = throttle(["failure", args.host, args.operation, failure.reason, failure.code ?? ""].join("|"));
  if (suppressed === null) return;
  logger.warn("RPC endpoint attempt failed", {
    host: args.host,
    endpoint: args.role,
    operation: args.operation,
    method: failure.method ?? "unknown",
    reason: failure.reason,
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    ...(failure.errorName ? { errorName: failure.errorName } : {}),
    attempt: args.attempt,
    latencyMs: failure.latencyMs ?? args.latencyMs,
    suppressed,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one observation on one endpoint at a time, preferring the configured
 * order but skipping endpoints whose circuit is open (see endpointHealth.ts),
 * so a whole observation, with any block it pins, stays on one endpoint.
 *
 * A chain answer (a revert with data, invalid params, an unknown method, or
 * the caller's `terminal`) is rethrown at once. An endpoint fault (-32603,
 * an unknown block, HTTP 5xx, a network error) moves to the next endpoint
 * without waiting. A rate limit or timeout retries the same endpoint after a
 * backoff that honors Retry-After. A local pacing refusal moves on without
 * counting against the endpoint. Whatever moved on, the last endpoint that
 * is still available keeps a bounded retry with backoff, and deferred
 * endpoints get one more attempt each before the observation fails.
 */
export async function withRpcFailover<Endpoint extends RpcEndpoint<unknown>, Result>(
  endpoints: readonly Endpoint[],
  observe: (endpoint: Endpoint) => Promise<Result>,
  options: RpcFailoverOptions = {},
): Promise<Result> {
  if (endpoints.length === 0) throw new Error("At least one RPC endpoint is required");
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("RPC attempts must be a positive integer");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("RPC retry delay must be a non-negative number");
  }
  const operation = options.operation ?? "rpc";
  const owner = {};
  try {
    return await observeInPlan(endpoints, observe, options, attempts, baseDelayMs, operation, owner);
  } finally {
    releaseRpcPlan(owner);
  }
}

async function observeInPlan<Endpoint extends RpcEndpoint<unknown>, Result>(
  endpoints: readonly Endpoint[],
  observe: (endpoint: Endpoint) => Promise<Result>,
  options: RpcFailoverOptions,
  attempts: number,
  baseDelayMs: number,
  operation: string,
  owner: object,
): Promise<Result> {
  const plan = planRpcEndpoints(endpoints, owner);
  // The last endpoint still available keeps the bounded retry; when every
  // endpoint is deferred, the last one tried does.
  let retryHome = plan.length - 1;
  for (let position = plan.length - 1; position >= 0; position -= 1) {
    if (plan[position]!.deferral === undefined) { retryHome = position; break; }
  }
  const primary = endpoints[0]!;
  const primaryDeferral: RpcDeferral | undefined = plan.find((entry) => entry.index === 0)?.deferral;
  let primaryReason: string | undefined;
  const failures: Error[] = [];
  const outcomes: Array<{ host: string; reason: string; attempts: number; code?: number }> = [];
  let endpointFaults = 0;

  for (const [position, planned] of plan.entries()) {
    const { endpoint, index, deferral } = planned;
    const home = position === retryHome;
    const limit = deferral !== undefined && !home ? 1 : attempts;
    let lastError: unknown;
    let lastFailure: RpcFailure | undefined;
    let tried = 0;
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      tried = attempt;
      const started = Date.now();
      const health = beginRpcAttempt(endpoint, owner);
      try {
        const result = await observe(endpoint);
        health.succeeded();
        if (index > 0) {
          reportFallback(options.onFallback, {
            primaryHost: primary.host,
            selectedHost: endpoint.host,
            operation,
            reason: primaryReason ?? (primaryDeferral ? "primary_" + primaryDeferral : "primary_unavailable"),
          });
        }
        return result;
      } catch (error) {
        if (options.terminal?.(error)) {
          health.inconclusive();
          throw error;
        }
        const failure = classifyRpcFailure(error);
        if (failure.kind === "terminal") {
          // A revert is a healthy endpoint's answer; invalid params prove nothing.
          if (failure.reason === "revert") health.succeeded(); else health.inconclusive();
          throw error;
        }
        if (failure.counted) {
          health.failed(failure);
          endpointFaults += 1;
          logEndpointFailure({
            host: endpoint.host, role: index === 0 ? "primary" : "fallback", operation, attempt,
            latencyMs: Date.now() - started, failure,
          });
        } else {
          health.inconclusive();
        }
        if (index === 0) primaryReason = failure.reason;
        lastError = error;
        lastFailure = failure;
        if (attempt >= limit) break;
        const wait = retryWait(failure, attempt, baseDelayMs, home);
        if (wait === null) break;
        // An endpoint whose circuit just opened is not retried while another can serve.
        if (!home && isRpcEndpointOpen(endpoint)) break;
        if (wait > 0) await sleep(wait);
      }
    }
    failures.push(failureSummary(endpoint.host, tried, lastError, lastFailure));
    outcomes.push({
      host: endpoint.host,
      reason: lastFailure?.reason ?? "unclassified",
      attempts: tried,
      ...(lastFailure?.code !== undefined ? { code: lastFailure.code } : {}),
    });
  }
  if (endpointFaults > 0) {
    const suppressed = throttle(["exhausted", operation].join("|"));
    if (suppressed !== null) {
      logger.warn("RPC observation failed on every endpoint", { operation, outcomes, suppressed });
    }
  }
  throw new AggregateError(
    failures,
    "RPC observation failed on the primary and every configured fallback",
  );
}

/** Milliseconds to wait before retrying the same endpoint, or null to move on. */
function retryWait(failure: RpcFailure, attempt: number, baseDelayMs: number, home: boolean): number | null {
  const backoff = baseDelayMs * attempt;
  switch (failure.kind) {
    case "failover":
    case "local":
      return home ? backoff : null;
    case "backoff":
      if (failure.retryAfterMs === undefined) return backoff;
      return failure.retryAfterMs > MAX_INLINE_RETRY_AFTER_MS ? null : Math.max(backoff, failure.retryAfterMs);
    default:
      return backoff;
  }
}

function reportFallback(
  onFallback: RpcFailoverOptions["onFallback"],
  detail: Omit<RpcFallbackDetail, "suppressed">,
): void {
  const suppressed = throttle(["fallback", detail.operation, detail.selectedHost, detail.reason].join("|"));
  if (suppressed === null) return;
  const report = { ...detail, suppressed };
  if (onFallback) onFallback(report);
  else logger.warn("RPC fallback selected", report);
}
