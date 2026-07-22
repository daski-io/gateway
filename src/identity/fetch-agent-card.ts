import {
  readBoundedJson,
  safeFetch,
  UrlSafetyError,
  validateUrlForOutbound,
  type ValidatedUrl,
} from "../util/urlSafety.js";

// Buyer agentURIs are user-supplied (or on-chain) and so must be treated
// as untrusted. We support three concrete shapes:
//
//   - data: URIs           — parsed inline, no network call.
//   - ipfs:// CIDs         — resolved through the configured HTTP gateway.
//   - https:// URLs        — fetched directly. http:// is rejected for the
//                            same reason the well-known fetch path rejects
//                            it: a plaintext fetch carries no integrity.
//
// All resolutions are bounded: 5-second timeout, 64 KB body cap, JSON
// must parse, top-level `name` field must be a non-empty string. We
// deliberately do NOT validate the `wallet` field against the on-chain
// agentWallet — per ERC-8004 the on-chain wallet is authoritative; the
// off-chain card's wallet is informational and a mismatch is not a
// registration error.

export const AGENT_CARD_TIMEOUT_MS = 5000;
export const AGENT_CARD_MAX_BYTES = 64 * 1024;

export class AgentCardFetchError extends Error {
  constructor(
    message: string,
    public readonly code: AgentCardFetchErrorCode,
  ) {
    super(message);
    this.name = "AgentCardFetchError";
  }
}

export type AgentCardFetchErrorCode =
  | "AGENT_URI_INVALID"
  | "AGENT_URI_SCHEME_BLOCKED"
  | "AGENT_URI_FETCH_FAILED"
  | "AGENT_URI_TIMEOUT"
  | "AGENT_URI_TOO_LARGE"
  | "AGENT_URI_NOT_JSON"
  | "AGENT_URI_MISSING_NAME";

export interface FetchedAgentCard {
  name: string;
  raw: Record<string, unknown>;
}

export interface FetchAgentCardOptions {
  ipfsGatewayUrl: string;
  // Test seam — caller supplies a fetch impl in vitest. Defaults to
  // `safeFetch` in production, which validates the host AND pins the
  // resolved IP at the connect layer to close DNS-rebinding TOCTOU.
  // The optional `preValidated` arg lets the caller skip a redundant
  // DNS lookup when it has already validated the URL.
  fetchFn?: (
    url: string,
    init?: RequestInit,
    preValidated?: ValidatedUrl,
  ) => Promise<Response>;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchAgentCard(
  uri: string,
  opts: FetchAgentCardOptions,
): Promise<FetchedAgentCard> {
  const fetchFn = opts.fetchFn ?? safeFetch;
  const timeoutMs = opts.timeoutMs ?? AGENT_CARD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? AGENT_CARD_MAX_BYTES;

  let raw: Record<string, unknown>;

  if (uri.startsWith("data:")) {
    raw = parseDataUri(uri, maxBytes);
  } else if (uri.startsWith("ipfs://")) {
    const httpUrl = ipfsToHttp(uri, opts.ipfsGatewayUrl);
    raw = await fetchHttp(httpUrl, fetchFn, timeoutMs, maxBytes);
  } else if (uri.startsWith("https://")) {
    raw = await fetchHttp(uri, fetchFn, timeoutMs, maxBytes);
  } else if (uri.startsWith("http://")) {
    throw new AgentCardFetchError(
      "agentURI must use https:// (http:// is not allowed)",
      "AGENT_URI_SCHEME_BLOCKED",
    );
  } else {
    throw new AgentCardFetchError(
      `agentURI scheme not supported: ${uri.slice(0, 16)}`,
      "AGENT_URI_SCHEME_BLOCKED",
    );
  }

  const nameRaw = raw["name"];
  if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
    throw new AgentCardFetchError(
      "agentURI JSON missing required 'name' field",
      "AGENT_URI_MISSING_NAME",
    );
  }

  return { name: nameRaw.trim(), raw };
}

function parseDataUri(uri: string, maxBytes: number): Record<string, unknown> {
  // Format per RFC 2397: data:[<mediatype>][;base64],<data>. We accept any
  // mediatype that yields parseable JSON (most senders use
  // application/json, but the on-chain default uses no explicit type) and
  // both base64 and percent-encoded payloads.
  const comma = uri.indexOf(",");
  if (comma < 0) {
    throw new AgentCardFetchError(
      "data: URI is malformed (no comma separator)",
      "AGENT_URI_INVALID",
    );
  }
  const meta = uri.slice(5, comma); // strip "data:"
  const payload = uri.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta) || /;base64;/i.test(meta);

  // Reject before decoding so a 10 MB encoded payload doesn't allocate
  // a 7.5 MB buffer just to fail the post-decode cap. base64 expands
  // ~4/3, percent-encoding can reach 3x for pure binary; both pre-checks
  // leave generous slack and only fire on payloads that couldn't fit
  // under maxBytes anyway.
  const inputCap = isBase64
    ? Math.ceil((maxBytes * 4) / 3) + 16
    : maxBytes * 3 + 16;
  if (payload.length > inputCap) {
    throw new AgentCardFetchError(
      `data: URI payload too large (encoded length ${payload.length} > cap ${inputCap})`,
      "AGENT_URI_TOO_LARGE",
    );
  }

  let buf: Buffer;
  try {
    if (isBase64) {
      buf = Buffer.from(payload, "base64");
    } else {
      buf = Buffer.from(decodeURIComponent(payload), "utf8");
    }
  } catch (err) {
    throw new AgentCardFetchError(
      `data: URI payload could not be decoded: ${(err as Error).message}`,
      "AGENT_URI_INVALID",
    );
  }
  if (buf.byteLength > maxBytes) {
    throw new AgentCardFetchError(
      `data: URI payload too large (>${maxBytes} bytes)`,
      "AGENT_URI_TOO_LARGE",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new AgentCardFetchError(
      `agentURI did not return valid JSON: ${(err as Error).message}`,
      "AGENT_URI_NOT_JSON",
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentCardFetchError(
      "agentURI JSON must be an object",
      "AGENT_URI_NOT_JSON",
    );
  }
  return parsed as Record<string, unknown>;
}

function ipfsToHttp(uri: string, gateway: string): string {
  const path = uri.slice("ipfs://".length).replace(/^\/+/, "");
  return gateway + path;
}

async function fetchHttp(
  url: string,
  fetchFn: (
    u: string,
    init?: RequestInit,
    preValidated?: ValidatedUrl,
  ) => Promise<Response>,
  timeoutMs: number,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let validated: ValidatedUrl | undefined;
  if (fetchFn === safeFetch) {
    try {
      validated = await validateUrlForOutbound(url);
    } catch (err) {
      if (err instanceof UrlSafetyError) {
        throw new AgentCardFetchError(
          `Failed to fetch agentURI: ${err.message}`,
          "AGENT_URI_FETCH_FAILED",
        );
      }
      throw err;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchFn(
        url,
        { signal: controller.signal, redirect: "manual" },
        validated,
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e?.name === "AbortError") {
        throw new AgentCardFetchError(
          `Failed to fetch agentURI: timed out after ${timeoutMs}ms`,
          "AGENT_URI_TIMEOUT",
        );
      }
      throw new AgentCardFetchError(
        `Failed to fetch agentURI: ${e?.message ?? String(err)}`,
        "AGENT_URI_FETCH_FAILED",
      );
    }

    if (!res.ok) {
      throw new AgentCardFetchError(
        `Failed to fetch agentURI: HTTP ${res.status}`,
        "AGENT_URI_FETCH_FAILED",
      );
    }

    let parsed: unknown;
    try {
      parsed = await readBoundedJson(res, maxBytes);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new AgentCardFetchError(
          `Failed to fetch agentURI: timed out after ${timeoutMs}ms`,
          "AGENT_URI_TIMEOUT",
        );
      }
      if (err instanceof UrlSafetyError) {
        if (err.code === "RESPONSE_TOO_LARGE") {
          throw new AgentCardFetchError(
            `agentURI body exceeds ${maxBytes} bytes`,
            "AGENT_URI_TOO_LARGE",
          );
        }
        throw new AgentCardFetchError(
          `agentURI did not return valid JSON: ${err.message}`,
          "AGENT_URI_NOT_JSON",
        );
      }
      throw new AgentCardFetchError(
        `agentURI did not return valid JSON: ${(err as Error).message}`,
        "AGENT_URI_NOT_JSON",
      );
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AgentCardFetchError(
        "agentURI JSON must be an object",
        "AGENT_URI_NOT_JSON",
      );
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}
