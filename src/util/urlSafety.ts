import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

// SSRF guard for outbound fetches. Two failure modes we close:
//
//   1) An on-chain `agentURI` (set by a whitelisted-but-malicious provider)
//      or a caller-supplied `providerA2AUrl` (MCP tool argument) points the
//      gateway at AWS IMDS, localhost RPC ports, internal services, or
//      `file:` schemes.
//   2) A reachable but malicious endpoint serves a multi-GB JSON body and
//      OOMs the gateway (default Node fetch's `res.json()` is unbounded).
//
// `validateUrlForOutbound` parses and resolves the URL host before a
// connection is opened, rejects private/loopback/link-local space, and
// returns the approved addresses. `safeFetch` connects directly to one of
// those addresses while preserving the original HTTP Host header and TLS
// server name, closing the DNS-rebinding window.

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
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_NOT_JSON";

const DEFAULT_MAX_BYTES = 256 * 1024;

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
  /^24[0-9]\./,
  /^25[0-5]\./,
];

const IPV6_BLOCKED = new net.BlockList();
IPV6_BLOCKED.addAddress("::", "ipv6");
IPV6_BLOCKED.addAddress("::1", "ipv6");
IPV6_BLOCKED.addSubnet("fc00::", 7, "ipv6");
IPV6_BLOCKED.addSubnet("fe80::", 10, "ipv6");
IPV6_BLOCKED.addSubnet("ff00::", 8, "ipv6");
IPV6_BLOCKED.addSubnet("::ffff:0:0", 96, "ipv6");

function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  return IPV4_BLOCKED.some((re) => re.test(ip));
}

function isPrivateIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  // Reject all IPv4-mapped IPv6 literals. They are unnecessary for provider
  // endpoints and otherwise create alternate spellings of blocked IPv4 hosts.
  return IPV6_BLOCKED.check(ip, "ipv6");
}

export interface ValidatedUrl {
  url: URL;
  resolvedAddrs: string[];
}

export function isPrivateOrLocalAddress(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return isPrivateIPv4(normalized) || isPrivateIPv6(ip);
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
  if (url.protocol !== "https:") {
    throw new UrlSafetyError(
      `URL scheme '${url.protocol}' not allowed (HTTPS is required)`,
      "URL_SCHEME_BLOCKED",
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new UrlSafetyError("URL has no hostname", "URL_INVALID");
  }

  // Strip IPv6 zone-id (`fe80::1%eth0`) and brackets before resolving.
  const cleanHost = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/%.+$/, "");
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
  if (url.username || url.password) {
    throw new UrlSafetyError(
      "URL credentials are not allowed",
      "URL_INVALID",
    );
  }
  for (const addr of addrs) {
    if (isPrivateOrLocalAddress(addr)) {
      throw new UrlSafetyError(
        `URL host resolves to a private/loopback address (${addr})`,
        "URL_PRIVATE_HOST",
      );
    }
  }
  return { url, resolvedAddrs: addrs };
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

/**
 * Converts the Fetch API request shape used by the gateway into a bounded
 * Node HTTP request that connects to an already-approved address.
 */
async function requestPinned(
  validated: ValidatedUrl,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(validated.url, init);
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? null
      : Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  headers.host = validated.url.host;

  let lastError: unknown;
  for (const address of validated.resolvedAddrs) {
    try {
      return await new Promise<Response>((resolve, reject) => {
        const transport = validated.url.protocol === "https:" ? https : http;
        const req = transport.request(
          {
            protocol: validated.url.protocol,
            hostname: address,
            port:
              validated.url.port ||
              (validated.url.protocol === "https:" ? 443 : 80),
            path: `${validated.url.pathname}${validated.url.search}`,
            method,
            headers,
            signal: request.signal,
            ...(validated.url.protocol === "https:"
              ? {
                  servername: net.isIP(
                    validated.url.hostname.replace(/^\[|\]$/g, ""),
                  )
                    ? undefined
                    : validated.url.hostname,
                }
              : {}),
          },
          (incoming) => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value != null) {
                responseHeaders.set(name, value);
              }
            }
            const status = incoming.statusCode ?? 502;
            const responseBody =
              method === "HEAD" ||
              status === 204 ||
              status === 205 ||
              status === 304
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
            resolve(
              new Response(responseBody, {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders,
              }),
            );
          },
        );
        req.once("error", reject);
        if (body) req.end(body);
        else req.end();
      });
    } catch (err) {
      lastError = err;
      if (request.signal.aborted) throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("outbound connection failed");
}

/**
 * Outbound fetch with DNS-rebinding protection. The host is resolved and
 * checked once, then the socket is connected directly to an approved IP.
 * Redirects are intentionally returned to the caller so every new target
 * must be independently validated.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  preValidated?: ValidatedUrl,
): Promise<Response> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Let the validator return a stable UrlSafetyError instead of leaking the
    // runtime-specific URL parser exception.
  }
  const validated =
    preValidated && parsed && preValidated.url.href === parsed.href
      ? preValidated
      : await validateUrlForOutbound(rawUrl);
  if (validated.resolvedAddrs.length === 0) {
    throw new UrlSafetyError(
      "URL resolved to no usable addresses",
      "URL_DNS_FAILED",
    );
  }
  return requestPinned(validated, { ...init, redirect: "manual" });
}
