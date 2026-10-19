/**
 * Classifies a failed RPC observation from the structured fields of the
 * errors in its cause chain: the JSON-RPC code and data the node returned,
 * the node's own error message (viem's `details`), the HTTP status and
 * headers, and viem's error class. It never reads an error's composed
 * `message`: viem's includes the endpoint URL and the request body, which can
 * carry an API key or raw transaction bytes and match any pattern by chance.
 */

/** What the failover does with a failed observation. */
export type RpcFailureKind =
  /** The chain's answer (a revert with data, invalid params, an unknown method): no retry, no failover. */
  | "terminal"
  /** The endpoint failed (internal error, unknown block, HTTP 5xx, network): try the next endpoint at once. */
  | "failover"
  /** The endpoint is overloaded or slow (rate limit, timeout): back off, honoring Retry-After, then retry. */
  | "backoff"
  /** A local refusal (pacing queue full or expired, caller abort): never the endpoint's fault. */
  | "local"
  /** Not an RPC failure (an assertion of the observation itself): retried as before, health unchanged. */
  | "unclassified";

export interface RpcFailure {
  kind: RpcFailureKind;
  /** A short token for logs, e.g. internal_error, rate_limited, timeout. */
  reason: string;
  /** Whether the failure counts against the endpoint's health. */
  counted: boolean;
  /** JSON-RPC error code, or the HTTP status for an HTTP failure. */
  code?: number;
  /** Requested wait before the same endpoint is asked again. */
  retryAfterMs?: number;
  /** The viem error class the classification read. */
  errorName?: string;
  /** JSON-RPC method and request latency, when the transport recorded them. */
  method?: string;
  latencyMs?: number;
}

/** A context the read transport attaches to the error of a failed request. */
export interface RpcRequestContext {
  method: string;
  latencyMs: number;
}

const REQUEST_CONTEXT = Symbol.for("daski.rpc.requestContext");
const MAX_CHAIN = 12;
/** Longest Retry-After the failover honors; a longer one is clamped. */
export const MAX_RETRY_AFTER_MS = 60_000;

const LOG_RANGE_LIMIT =
  /block range|range (?:is )?too (?:large|wide|big|long|broad|dense)|range limit|max(?:imum)? (?:block )?range|(?:more|greater) than \d[\d,]* (?:results|logs|blocks)|returned more than|too many (?:results|logs|blocks)|response size|results? (?:limit|window|size)|limited to (?:a )?\d|exceeds? (?:the )?max(?:imum)? (?:results|logs|block range|range)|query exceeds|log response/i;
const RATE_LIMIT =
  /rate.?limit|too many requests|request limit|requests? per (?:second|minute)|capacity exceeded|quota|daily request|throttl/i;
const UNKNOWN_BLOCK =
  /header not found|unknown block|block not found|could not find block|no block found|block (?:number )?(?:is )?(?:not (?:yet )?available|in the future)|after last accepted block|cannot query unfinalized/i;
const STATE_UNAVAILABLE = /missing trie node|historical state|state (?:is )?(?:not available|unavailable|pruned)|pruned/i;
const EXECUTION_ANSWER =
  /revert|out of gas|invalid opcode|invalid jump|stack (?:under|over)flow|gas required exceeds|insufficient funds|execution (?:aborted|error)/i;

type ErrorRecord = Record<string, unknown> & { name?: unknown; cause?: unknown };

function record(value: unknown): ErrorRecord | null {
  return value !== null && typeof value === "object" ? value as ErrorRecord : null;
}

/** The error and its causes, outermost first. */
export function rpcErrorChain(error: unknown): ErrorRecord[] {
  const links: ErrorRecord[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (links.length < MAX_CHAIN) {
    const link = record(current);
    if (!link || seen.has(link)) break;
    seen.add(link);
    links.push(link);
    current = link.cause;
  }
  return links;
}

const nameOf = (link: ErrorRecord): string => typeof link.name === "string" ? link.name : "";

/**
 * A viem error: a BaseError (which carries `shortMessage` and `version`) or
 * one of its RPC classes by name. Codes and node messages are read only from
 * these, so an unrelated error that happens to carry a numeric `code` is not
 * mistaken for a node's answer.
 */
function isViemError(link: ErrorRecord): boolean {
  return (typeof link.shortMessage === "string" && typeof link.version === "string") ||
    /(?:RpcError|RpcRequestError|HttpRequestError|TimeoutError)$/.test(nameOf(link));
}

function hexData(value: unknown): string | null {
  const nested = record(value);
  const data = nested && typeof nested.data === "string" ? nested.data : value;
  return typeof data === "string" && /^0x[0-9a-fA-F]+$/.test(data) && data !== "0x" ? data : null;
}

/** A deterministic contract revert that returned revert data. */
export function hasRevertData(error: unknown): boolean {
  return rpcErrorChain(error).some((link) =>
    (nameOf(link) === "ContractFunctionRevertedError" && hexData(link.raw) !== null) ||
    (isViemError(link) && link.code === 3 && hexData(link.data) !== null),
  );
}

/** The JSON-RPC error the node returned: the innermost viem link with a numeric code. */
function rpcCode(links: readonly ErrorRecord[]): { code: number; link: ErrorRecord } | null {
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const link = links[index]!;
    if (isViemError(link) && typeof link.code === "number" && Number.isInteger(link.code)) {
      return { code: link.code, link };
    }
  }
  return null;
}

/**
 * The node's own error text: the JSON-RPC error message viem keeps as
 * `details` (or the HTTP body an endpoint answered with), never viem's
 * composed message. For an error that is not viem's, its own message.
 */
export function rpcNodeMessage(error: unknown): string {
  const links = rpcErrorChain(error);
  const viem = links.filter(isViemError);
  if (viem.length === 0) {
    const first = links[0];
    return first && typeof first.message === "string" ? first.message : "";
  }
  const request = viem.find((link) => nameOf(link) === "RpcRequestError" || nameOf(link) === "HttpRequestError");
  const source = request ?? viem.find((link) => typeof link.code === "number");
  return source && typeof source.details === "string" ? source.details : "";
}

function retryAfterMs(links: readonly ErrorRecord[]): number | undefined {
  for (const link of links) {
    const headers = record(link.headers);
    const get = headers && typeof headers.get === "function"
      ? (headers.get as (name: string) => unknown).bind(headers)
      : null;
    const header = get?.("retry-after");
    if (typeof header === "string" && header.trim()) {
      const seconds = Number(header.trim());
      const at = Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : Date.parse(header);
      if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
    }
    // Infura answers a rate limit with `data.backoff_seconds`.
    const data = record(link.data);
    const backoff = data?.backoff_seconds ?? data?.retry_after;
    if (typeof backoff === "number" && Number.isFinite(backoff) && backoff >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, backoff * 1_000);
    }
  }
  return undefined;
}

export function rpcRequestContext(error: unknown): RpcRequestContext | undefined {
  for (const link of rpcErrorChain(error)) {
    const context = (link as Record<symbol, unknown>)[REQUEST_CONTEXT];
    if (context) return context as RpcRequestContext;
  }
  return undefined;
}

/** Records the failed request's method and latency on its error, invisibly to logs. */
export function annotateRpcError(error: unknown, context: RpcRequestContext): void {
  const link = record(error);
  if (!link || Object.prototype.hasOwnProperty.call(link, REQUEST_CONTEXT) || !Object.isExtensible(link)) return;
  try {
    Object.defineProperty(link, REQUEST_CONTEXT, { value: context, enumerable: false, configurable: true });
  } catch {
    // A frozen or exotic error simply carries no context.
  }
}

function fromMessage(text: string, code: number | undefined, errorName: string): RpcFailure | null {
  if (LOG_RANGE_LIMIT.test(text)) return { kind: "failover", reason: "log_range_limit", counted: false, code, errorName };
  if (RATE_LIMIT.test(text)) return { kind: "backoff", reason: "rate_limited", counted: true, code, errorName };
  if (UNKNOWN_BLOCK.test(text)) return { kind: "failover", reason: "unknown_block", counted: true, code, errorName };
  if (STATE_UNAVAILABLE.test(text)) return { kind: "failover", reason: "state_unavailable", counted: false, code, errorName };
  if (EXECUTION_ANSWER.test(text)) return { kind: "failover", reason: "execution_error", counted: false, code, errorName };
  return null;
}

function classifyLinks(links: readonly ErrorRecord[]): RpcFailure {
  const names = links.map(nameOf);
  if (names.includes("RpcQueueUnavailableError")) return { kind: "local", reason: "queue", counted: false };
  if (names.includes("AbortError")) return { kind: "local", reason: "aborted", counted: false };
  if (hasRevertData(links[0])) return { kind: "terminal", reason: "revert", counted: false, code: 3 };
  if (names.includes("TimeoutError")) return { kind: "backoff", reason: "timeout", counted: true, errorName: "TimeoutError" };
  const rpc = rpcCode(links);
  if (rpc) {
    const { code } = rpc;
    const errorName = nameOf(rpc.link);
    const text = typeof rpc.link.details === "string" ? rpc.link.details : "";
    const retryAfter = retryAfterMs(links);
    if (code === -32005 || code === 429) {
      if (LOG_RANGE_LIMIT.test(text)) return { kind: "failover", reason: "log_range_limit", counted: false, code, errorName };
      return { kind: "backoff", reason: "rate_limited", counted: true, code, errorName, retryAfterMs: retryAfter };
    }
    const answered = fromMessage(text, code, errorName);
    if (answered?.reason === "log_range_limit") return answered;
    if (code === -32602) return { kind: "terminal", reason: "invalid_params", counted: false, code, errorName };
    if (code === -32601) return { kind: "terminal", reason: "method_not_found", counted: false, code, errorName };
    if (code === 3) return { kind: "failover", reason: "revert_without_data", counted: false, code, errorName };
    if (answered) return answered.kind === "backoff" ? { ...answered, retryAfterMs: retryAfter } : answered;
    if (code === -32603) return { kind: "failover", reason: "internal_error", counted: true, code, errorName };
    return { kind: "failover", reason: "node_error", counted: true, code, errorName };
  }
  const httpError = links.find((link) => nameOf(link) === "HttpRequestError");
  if (httpError) {
    const status = typeof httpError.status === "number" ? httpError.status : undefined;
    const errorName = "HttpRequestError";
    if (status === 429) {
      return { kind: "backoff", reason: "rate_limited", counted: true, code: status, errorName, retryAfterMs: retryAfterMs(links) };
    }
    if (status === 408) return { kind: "backoff", reason: "timeout", counted: true, code: status, errorName };
    if (status === undefined) return { kind: "failover", reason: "network", counted: true, errorName };
    if (status >= 500) return { kind: "failover", reason: "http_5xx", counted: true, code: status, errorName };
    return { kind: "failover", reason: "http_status", counted: true, code: status, errorName };
  }
  const reverted = links.find((link) => nameOf(link) === "ContractFunctionRevertedError");
  if (reverted) {
    // A revert without data viem built from a node error it could not attribute.
    const text = typeof reverted.reason === "string" ? reverted.reason : "";
    const answered = fromMessage(text, undefined, "ContractFunctionRevertedError");
    return answered ?? { kind: "failover", reason: "internal_error", counted: true, errorName: "ContractFunctionRevertedError" };
  }
  if (names.includes("BlockNotFoundError")) return { kind: "failover", reason: "unknown_block", counted: true, errorName: "BlockNotFoundError" };
  if (names.includes("ResponseBodyTooLargeError")) {
    return { kind: "failover", reason: "response_too_large", counted: false, errorName: "ResponseBodyTooLargeError" };
  }
  return { kind: "unclassified", reason: "unclassified", counted: false };
}

export function classifyRpcFailure(error: unknown): RpcFailure {
  const failure = classifyLinks(rpcErrorChain(error));
  const context = rpcRequestContext(error);
  return context ? { ...failure, method: context.method, latencyMs: context.latencyMs } : failure;
}

/**
 * An eth_getLogs refusal that a smaller block range can satisfy: a range or
 * result-count limit, or a response too large to read. Any other failure is
 * the endpoint's and is not retried by splitting the range.
 */
export function isLogRangeLimitError(error: unknown): boolean {
  const links = rpcErrorChain(error);
  if (links.some((link) => nameOf(link) === "ResponseBodyTooLargeError")) return true;
  if (links.some((link) => nameOf(link) === "HttpRequestError" && link.status === 413)) return true;
  return LOG_RANGE_LIMIT.test(rpcNodeMessage(error));
}

/** Outcome of a failed raw-transaction broadcast. */
export type BroadcastFailure = "already_known" | "nonce_conflict" | "balance_fee" | "unavailable";

const BROADCAST_NODE_CLASSES: Readonly<Record<string, BroadcastFailure>> = {
  NonceTooLowError: "nonce_conflict",
  InsufficientFundsError: "balance_fee",
  FeeCapTooLowError: "balance_fee",
  FeeCapTooHighError: "balance_fee",
  TipAboveFeeCapError: "balance_fee",
  IntrinsicGasTooLowError: "balance_fee",
  IntrinsicGasTooHighError: "balance_fee",
};

/**
 * Classifies a failed eth_sendRawTransaction. A viem error is read from its
 * node error class and the node's own message only; the composed message
 * embeds the endpoint URL and the raw transaction, whose hex can contain
 * "fee" or any other word. Fee words must stand alone for the same reason.
 * Transport faults (HTTP, timeouts, -32603) are `unavailable`. An error that
 * is not viem's keeps the existing rules over its own message.
 */
export function classifyBroadcastFailure(error: unknown): BroadcastFailure {
  const links = rpcErrorChain(error);
  if (!links.some(isViemError)) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already known|known transaction/i.test(message)) return "already_known";
    if (/nonce too low|replacement transaction underpriced/i.test(message)) return "nonce_conflict";
    if (/insufficient funds|intrinsic gas|invalid sender|fee|max fee|base fee/i.test(message)) return "balance_fee";
    return "unavailable";
  }
  if (links.some((link) => nameOf(link) === "TimeoutError")) return "unavailable";
  const text = rpcNodeMessage(error);
  if (/already known|known transaction|already imported/i.test(text)) return "already_known";
  if (/nonce too low|replacement transaction underpriced/i.test(text)) return "nonce_conflict";
  if (/insufficient funds|intrinsic gas|invalid sender|\bfees?\b|fee cap|max fee|base fee|priority fee/i.test(text)) {
    return "balance_fee";
  }
  for (const link of links) {
    const known = BROADCAST_NODE_CLASSES[nameOf(link)];
    if (known) return known;
  }
  return "unavailable";
}
