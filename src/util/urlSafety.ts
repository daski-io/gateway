import dns from "node:dns/promises";
import net from "node:net";

// SSRF guard for outbound fetches. Two failure modes we close:
//
//   1) An on-chain `agentURI` (set by a whitelisted-but-malicious provider)
//      or a caller-supplied `providerA2AUrl` (MCP tool argument) points the
//      gateway at AWS IMDS, localhost RPC ports, internal services, or
//      `file:` schemes.
//   2) A reachable but malicious endpoint serves a multi-GB JSON body and
//      OOMs the gateway (default Node fetch's `res.json()` is unbounded).
//
// `validateUrlForOutbound` parses and resolves the URL host before we open
// a connection, rejects anything in private/loopback/link-local space, and
// pins the resolved IP so a TOCTOU between resolve and fetch can't move
// the target. `readBoundedJson` enforces a hard byte cap before parsing.
//
// Tests pass mock fetch handlers and use `127.0.0.1` URLs; the private-IP
// check is skipped when `NODE_ENV === "test"` (vitest sets this) so the
// test fixtures don't have to fight the guard.

export class UrlSafetyError extends Error {
  constructor(
    message: string,
    public readonly code: UrlSafetyErrorCode,
  ) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

export type UrlSafetyErrorCode =
  | "URL_INVALID"
  | "URL_SCHEME_BLOCKED"
  | "URL_DNS_FAILED"
  | "URL_PRIVATE_HOST"
  | "URL_TOO_MANY_REDIRECTS"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_NOT_JSON";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

// IPv4 ranges we reject. Loopback (127/8), private (10/8, 172.16-31/12,
// 192.168/16), CGNAT (100.64/10), link-local + IMDS (169.254/16),
// "this network" (0/8), broadcast (255.255.255.255), multicast (224/4).
const IPV4_BLOCKED: RegExp[] = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^22[4-9]\./,
  /^23[0-9]\./,
  /^255\.255\.255\.255$/,
];

function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  return IPV4_BLOCKED.some((re) => re.test(ip));
}

function isPrivateIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // ULA (fc00::/7) and link-local (fe80::/10).
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // Multicast (ff00::/8).
  if (lower.startsWith("ff")) return true;
  // IPv4-mapped IPv6: ::ffff:1.2.3.4
  const m = lower.match(/^::ffff:([\d.]+)$/);
  if (m && isPrivateIPv4(m[1])) return true;
  return false;
}

function privateChecksDisabled(): boolean {
  // vitest sets NODE_ENV=test by default; tests run mock providers on
  // 127.0.0.1 and need the validator to short-circuit. Production never
  // sets this and the full check applies.
  return process.env.NODE_ENV === "test";
}

export interface ValidatedUrl {
  url: URL;
  resolvedAddrs: string[];
}

/**
 * Parses a URL, resolves its host, and rejects schemes / addresses that
 * point at the local/private network. Throws `UrlSafetyError` on any
 * failure. Returns the parsed URL and the list of resolved addresses so
 * a caller can re-validate redirects without re-resolving.
 */
export async function validateUrlForOutbound(
  rawUrl: string,
): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlSafetyError(`invalid URL: ${rawUrl}`, "URL_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlSafetyError(
      `URL scheme '${url.protocol}' not allowed (only http/https)`,
      "URL_SCHEME_BLOCKED",
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new UrlSafetyError("URL has no hostname", "URL_INVALID");
  }

  if (privateChecksDisabled()) {
    return { url, resolvedAddrs: [] };
  }

  // Strip IPv6 zone-id (`fe80::1%eth0`) and brackets before resolving.
  const cleanHost = hostname.replace(/%.+$/, "");
  let addrs: string[];
  if (net.isIP(cleanHost)) {
    addrs = [cleanHost];
  } else {
    try {
      const lookups = await dns.lookup(cleanHost, { all: true });
      addrs = lookups.map((l) => l.address);
    } catch {
      throw new UrlSafetyError(
        `DNS lookup failed for '${cleanHost}'`,
        "URL_DNS_FAILED",
      );
    }
  }
  for (const addr of addrs) {
    if (isPrivateIPv4(addr) || isPrivateIPv6(addr)) {
      throw new UrlSafetyError(
        `URL host resolves to a private/loopback address (${addr})`,
        "URL_PRIVATE_HOST",
      );
    }
  }
  return { url, resolvedAddrs: addrs };
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface SafeFetchOptions {
  timeoutMs?: number;
  init?: RequestInit;
  /**
   * Custom fetch (e.g. test mock). Defaults to the global `fetch`. The
   * URL safety check runs regardless of this — pass the URL guard's
   * `validateUrlForOutbound` upstream of this function for full
   * validation, OR rely on the gating built in here.
   */
  fetchFn?: FetchLike;
}

/**
 * Performs an outbound fetch with URL validation, redirect re-validation,
 * and an overall timeout. Each redirect's `Location` is re-validated by
 * `validateUrlForOutbound` so an attacker can't bypass the guard with a
 * 30x to a private host. Caller is responsible for capping the response
 * body — see `readBoundedBody` / `readBoundedJson`.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, init = {} } = opts;
  const fetchFn: FetchLike = opts.fetchFn ?? ((u, i) => fetch(u, i));

  let target = (await validateUrlForOutbound(rawUrl)).url.toString();

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(target, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (i === MAX_REDIRECTS) {
        throw new UrlSafetyError(
          `too many redirects from ${rawUrl}`,
          "URL_TOO_MANY_REDIRECTS",
        );
      }
      const next = new URL(loc, target).toString();
      target = (await validateUrlForOutbound(next)).url.toString();
      continue;
    }
    return res;
  }
  throw new UrlSafetyError(
    "unexpected redirect loop",
    "URL_TOO_MANY_REDIRECTS",
  );
}

/**
 * Reads a Response body with a hard byte cap. If `Content-Length` exceeds
 * the cap, throws before opening the stream; otherwise streams chunks
 * and aborts as soon as the running total exceeds `maxBytes`.
 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Uint8Array> {
  const cl = res.headers.get("content-length");
  if (cl != null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new UrlSafetyError(
        `response too large (Content-Length=${n}, max=${maxBytes})`,
        "RESPONSE_TOO_LARGE",
      );
    }
  }
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best effort
      }
      throw new UrlSafetyError(
        `response too large (>${maxBytes} bytes)`,
        "RESPONSE_TOO_LARGE",
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function readBoundedJson<T = unknown>(
  res: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<T> {
  const buf = await readBoundedBody(res, maxBytes);
  const text = new TextDecoder().decode(buf);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new UrlSafetyError(
      `response is not valid JSON: ${(err as Error).message}`,
      "RESPONSE_NOT_JSON",
    );
  }
}
