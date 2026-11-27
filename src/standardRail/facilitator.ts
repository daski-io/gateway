import {facilitatorTransportRequest} from "./sandboxFacilitatorTransport.js";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { StandardRailConfig } from "./config.js";
import { isNonPublicAddress } from "./network.js";
import { discardResponseBody } from "./boundedJson.js";
import { assertNoDuplicateJsonKeys } from "./canonical.js";
import { logger } from "../util/logger.js";
import { activeRequestSignal } from "../mcp/requestContext.js";

export interface StandardFacilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  assertSupported(network: string): Promise<void>;
}

const FAILURE_TEXT_LIMIT = 200;
const REFUSAL_REASON_FIELDS = ["errorReason", "invalidReason", "errorType", "errorMessage"] as const;

/**
 * A facilitator answer outside 2xx. It keeps the HTTP status and the reason
 * the body names, if any, so a refused verify or settle can be told apart
 * from an outage in the logs. It never holds the request or credentials.
 */
export class FacilitatorHttpError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(operation: string, status: number, reason?: string) {
    super(`Facilitator ${operation} rejected the request`);
    this.name = "FacilitatorHttpError";
    this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}

function boundedText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, FAILURE_TEXT_LIMIT);
}

/** The reason a refusal body names, from the fields facilitators use for it. */
export function facilitatorRefusalReason(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parts = REFUSAL_REASON_FIELDS
    .map((field) => (value as Record<string, unknown>)[field])
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? undefined : boundedText(parts.join(": "));
}

/**
 * What a failed facilitator call can say in a log: the error's kind, the
 * facilitator's HTTP status and reason when it answered, and otherwise the
 * bounded message and network code (a timeout, a reset, a DNS refusal).
 */
export function facilitatorFailureSummary(error: unknown): Record<string, unknown> {
  if (error instanceof FacilitatorHttpError) {
    return { errorName: error.name, status: error.status, ...(error.reason ? { reason: error.reason } : {}) };
  }
  if (error instanceof Error) {
    const code = (error.cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
    return {
      errorName: error.name,
      message: boundedText(error.message),
      ...(typeof code === "string" ? { code: boundedText(code) } : {}),
    };
  }
  return { errorName: typeof error };
}

export class CdpStandardFacilitator implements StandardFacilitator {
  private readonly baseUrl: string;
  private readonly host: string;

  constructor(private readonly config: StandardRailConfig) {
    const parsed = new URL(config.facilitatorBaseUrl);
    this.baseUrl = parsed.href.replace(/\/$/, "");
    this.host = parsed.host;
  }

  async assertSupported(network: string): Promise<void> {
    const supported = await this.call<SupportedResponse>("supported", "GET");
    if (!advertisesExactEip3009(supported, network)) {
      throw new Error(`Selected facilitator does not advertise an exact EIP-3009 ${network} rail`);
    }
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.call("verify", "POST", {
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.call("settle", "POST", {
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: requirements,
    });
  }

  private async call<T>(
    operation: "verify" | "settle" | "supported",
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const basePath = new URL(this.baseUrl).pathname.replace(/\/$/, "");
    const path = `${basePath}/${operation}`;
    const jwt = await generateJwt({
      apiKeyId: this.config.facilitatorApiKeyId,
      apiKeySecret: this.config.facilitatorApiKeySecret,
      requestMethod: method,
      requestHost: this.host,
      requestPath: path,
    });
    const transport=facilitatorTransportRequest(this.config.sandboxFacilitatorTransport,`${this.baseUrl}/${operation}`,operation,body);
    const target=transport.url,hostname=new URL(target).hostname;
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new Error("Facilitator DNS resolved outside the public network");
    }
    const response = await pinnedFetch(target, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        ...transport.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      signal: operation === "verify"
        ? activeRequestSignal(AbortSignal.timeout(this.config.facilitatorTimeoutMs))
        : AbortSignal.timeout(this.config.facilitatorTimeoutMs),
    }, addresses[0]!);
    if (!response.ok) {
      let reason: string | undefined;
      try {
        reason = facilitatorRefusalReason(await this.readBoundedJson(response, 16_000));
      } catch {
        // An unreadable refusal body still reports its status.
      }
      throw new FacilitatorHttpError(operation, response.status, reason);
    }
    const value = await this.readBoundedJson(response, 256_000);
    this.validateResponse(operation, value);
    const discovery = facilitatorDiscoveryStatus(response.headers.get("extension-responses"));
    if (discovery) {
      const details = { operation, ...discovery };
      if (discovery.status === "rejected") logger.warn("Facilitator Bazaar discovery rejected", details);
      else logger.info("Facilitator Bazaar discovery status", details);
    }
    return value as T;
  }

  private async readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
      await discardResponseBody(response);
      throw new Error("Facilitator response media type is invalid");
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
      await discardResponseBody(response);
      throw new Error("Facilitator response is too large");
    }
    if (!response.body) throw new Error("Facilitator response is empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("Facilitator response is too large");
      }
      chunks.push(next.value);
    }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    assertNoDuplicateJsonKeys(text);
    return JSON.parse(text);
  }

  private validateResponse(operation: string, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Facilitator ${operation} response is malformed`);
    }
    const response = value as Record<string, unknown>;
    const assertAllowed = (allowed: readonly string[]): void => {
      const unknown = Object.keys(response).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) throw new Error(`Facilitator ${operation} response has unknown fields`);
    };
    if (operation === "supported") {
      assertAllowed(["kinds", "extensions", "signers"]);
      if (!Array.isArray(response.kinds) || !Array.isArray(response.extensions) ||
        !response.signers || typeof response.signers !== "object") {
        throw new Error("Facilitator supported response is malformed");
      }
      for (const kind of response.kinds) {
        if (!kind || typeof kind !== "object" || Array.isArray(kind) ||
          Object.keys(kind).some((key) => !["x402Version", "scheme", "network", "extra"].includes(key))) {
          throw new Error("Facilitator supported kind is malformed");
        }
      }
      return;
    }
    if (operation === "verify") {
      assertAllowed(["isValid", "invalidReason", "invalidMessage", "payer", "extensions", "extra"]);
      if (typeof response.isValid !== "boolean" ||
        (response.payer !== undefined && typeof response.payer !== "string")) {
        throw new Error("Facilitator verify response is malformed");
      }
      return;
    }
    assertAllowed([
      "success", "errorReason", "errorMessage", "payer", "transaction", "network", "amount",
      "extensions", "extra",
    ]);
    if (
      typeof response.success !== "boolean" || typeof response.transaction !== "string" ||
      typeof response.network !== "string" ||
      (response.payer !== undefined && typeof response.payer !== "string")
    ) throw new Error("Facilitator settle response is malformed");
  }
}

/** Optional indexing diagnostics must never alter payment settlement semantics. */
export function facilitatorDiscoveryStatus(header: string | null): { status: "success" | "processing" | "rejected"; rejectedReason?: string } | null {
  if (!header || header.length > 16_384 || !/^[A-Za-z0-9+/_=-]+$/.test(header)) return null;
  try {
    const text = Buffer.from(header, "base64").toString("utf8");
    assertNoDuplicateJsonKeys(text);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const bazaar = (value as Record<string, unknown>).bazaar;
    if (!bazaar || typeof bazaar !== "object" || Array.isArray(bazaar)) return null;
    const { status, rejectedReason } = bazaar as Record<string, unknown>;
    if (status !== "success" && status !== "processing" && status !== "rejected") return null;
    return { status, ...(status === "rejected" && typeof rejectedReason === "string"
      ? { rejectedReason: rejectedReason.slice(0, 512) } : {}) };
  } catch { return null; }
}

export function advertisesExactEip3009(supported: SupportedResponse, network: string): boolean {
  return supported.kinds.some((kind) =>
    kind.x402Version === 2 && kind.scheme === "exact" && kind.network === network &&
      (kind.extra?.assetTransferMethod === undefined || kind.extra.assetTransferMethod === "eip3009"),
  );
}

function pinnedFetch(
  target: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal },
  selected: { address: string; family: number },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(target, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      lookup: createPinnedLookup(selected),
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          headers.append(name, String(item));
        }
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

export function createPinnedLookup(selected: { address: string; family: number }): LookupFunction {
  const family = selected.family === 6 ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: selected.address, family }]);
      return;
    }
    callback(null, selected.address, family);
  };
}
