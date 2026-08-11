import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { hasDuplicateJsonObjectKeys } from "../http/jsonDuplicateKeys.js";
import type {
  BazaarFacilitatorClient,
  FacilitatorCallResult,
  BazaarRuntimeAdapterIdentity,
} from "./types.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_EXTENSION_HEADER_BYTES = 8 * 1024;
const CDP_FACILITATOR_ORIGIN = "https://api.cdp.coinbase.com";
const CDP_FACILITATOR_PATH = "/platform/v2/x402";

export interface CdpFacilitatorClientOptions {
  identity: BazaarRuntimeAdapterIdentity;
  baseUrl?: string;
  createAuthHeaders: (
    path: "verify" | "settle",
  ) => Promise<Record<string, string>>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  allowInsecureTestUrl?: boolean;
}

export function createCdpAuthHeaders(credentials: {
  apiKeyId: string;
  apiKeySecret: string;
}): CdpFacilitatorClientOptions["createAuthHeaders"] {
  if (!credentials.apiKeyId || !credentials.apiKeySecret) {
    throw new Error("CDP facilitator credentials are required");
  }
  return async (path) => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId: credentials.apiKeyId,
      apiKeySecret: credentials.apiKeySecret,
      requestMethod: "POST",
      requestHost: "api.cdp.coinbase.com",
      requestPath: `${CDP_FACILITATOR_PATH}/${path}`,
    })}`,
  });
}

export class CdpFacilitatorClient implements BazaarFacilitatorClient {
  readonly identity: BazaarRuntimeAdapterIdentity;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CdpFacilitatorClientOptions) {
    this.identity = { ...options.identity };
    const url = new URL(
      options.baseUrl ?? "https://api.cdp.coinbase.com/platform/v2/x402",
    );
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !options.allowInsecureTestUrl)
    ) {
      throw new Error("CDP facilitator URL must be credential-free HTTPS");
    }
    if (options.allowInsecureTestUrl && !isLoopbackHost(url.hostname)) {
      throw new Error("insecure CDP facilitator test URL must be loopback-only");
    }
    if (
      !options.allowInsecureTestUrl &&
      (url.origin !== CDP_FACILITATOR_ORIGIN || url.pathname !== CDP_FACILITATOR_PATH)
    ) {
      throw new Error("production CDP facilitator URL must use the pinned CDP endpoint");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    ) throw new Error("CDP facilitator timeout is invalid");
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signal: AbortSignal,
  ): Promise<FacilitatorCallResult<VerifyResponse>> {
    const result = await this.post("verify", payload, requirements, signal);
    return { response: parseVerify(result.body), extensionResponses: result.extensionResponses };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signal: AbortSignal,
  ): Promise<FacilitatorCallResult<SettleResponse>> {
    const result = await this.post("settle", payload, requirements, signal);
    return { response: parseSettle(result.body), extensionResponses: result.extensionResponses };
  }

  private async post(
    path: "verify" | "settle",
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
    signal: AbortSignal,
  ): Promise<{ body: Record<string, unknown>; extensionResponses: string | null }> {
    signal.throwIfAborted();
    const authHeaders = validateAuthHeaders(await withTimeout(
      this.options.createAuthHeaders(path),
      this.timeoutMs,
      `CDP facilitator ${path} authentication timed out`,
      signal,
    ),
    );
    signal.throwIfAborted();
    const response = await this.fetchFn(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CDP facilitator ${path} returned ${response.status}`);
    }
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CDP facilitator ${path} response was not JSON`);
    }
    const contentLengthHeader = response.headers.get("content-length");
    if (
      contentLengthHeader !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(contentLengthHeader) ||
        BigInt(contentLengthHeader) > BigInt(MAX_RESPONSE_BYTES))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CDP facilitator ${path} response exceeded size limit`);
    }
    const bytes = await readBoundedBody(response, path);
    if (hasDuplicateJsonObjectKeys(Buffer.from(bytes))) {
      throw new Error(`CDP facilitator ${path} response contained duplicate JSON keys`);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`CDP facilitator ${path} response was not valid JSON`);
    }
    if (!isRecord(body)) {
      throw new Error(`CDP facilitator ${path} response was not an object`);
    }
    if (!response.ok && body.isValid === true) {
      throw new Error(`CDP facilitator ${path} returned a contradictory response`);
    }
    if (!response.ok && body.success === true) {
      throw new Error(`CDP facilitator ${path} returned a contradictory response`);
    }
    const extensionResponses = response.headers.get("extension-responses");
    if (
      extensionResponses !== null &&
      Buffer.byteLength(extensionResponses, "utf8") > MAX_EXTENSION_HEADER_BYTES
    ) {
      throw new Error(`CDP facilitator ${path} extension header exceeded size limit`);
    }
    return { body, extensionResponses };
  }
}

async function readBoundedBody(
  response: Response,
  path: "verify" | "settle",
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`CDP facilitator ${path} response exceeded size limit`);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validateAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (validated[normalized] !== undefined) {
      throw new Error("CDP facilitator authentication returned a duplicate header");
    }
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > 8 * 1024 ||
      (normalized === "authorization" && !/^Bearer [A-Za-z0-9_.-]+$/.test(value)) ||
      (normalized === "correlation-context" && !/^[\x20-\x7e]+$/.test(value)) ||
      (normalized !== "authorization" && normalized !== "correlation-context")
    ) {
      throw new Error("CDP facilitator authentication returned an unsafe header");
    }
    validated[normalized] = value;
  }
  if (validated.authorization === undefined) {
    throw new Error("CDP facilitator authentication omitted Authorization");
  }
  return validated;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parseVerify(value: Record<string, unknown>): VerifyResponse {
  assertKeys(value, [
    "extensions", "extra", "invalidMessage", "invalidReason", "isValid", "payer",
  ]);
  if (typeof value.isValid !== "boolean") throw new Error("invalid CDP verify response");
  optionalStrings(value, ["invalidMessage", "invalidReason", "payer"]);
  optionalRecords(value, ["extensions", "extra"]);
  return value as VerifyResponse;
}

function parseSettle(value: Record<string, unknown>): SettleResponse {
  assertKeys(value, [
    "amount", "errorMessage", "errorReason", "extensions", "extra", "network",
    "payer", "success", "transaction",
  ]);
  if (typeof value.success !== "boolean") throw new Error("invalid CDP settle response");
  optionalStrings(value, [
    "amount", "errorMessage", "errorReason", "network", "payer", "transaction",
  ]);
  optionalRecords(value, ["extensions", "extra"]);
  return value as SettleResponse;
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("CDP facilitator response contained an unknown field");
  }
}

function optionalStrings(value: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => value[key] !== undefined && typeof value[key] !== "string")) {
    throw new Error("CDP facilitator response contained a malformed string field");
  }
}

function optionalRecords(value: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => value[key] !== undefined && !isRecord(value[key]))) {
    throw new Error("CDP facilitator response contained a malformed object field");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}
