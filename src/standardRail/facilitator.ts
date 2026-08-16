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
import { assertNoDuplicateJsonKeys } from "./canonical.js";

export interface StandardFacilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  assertSupported(network: string): Promise<void>;
}

export class CdpStandardFacilitator implements StandardFacilitator {
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly hostname: string;

  constructor(private readonly config: StandardRailConfig) {
    const parsed = new URL(config.facilitatorBaseUrl);
    this.baseUrl = parsed.href.replace(/\/$/, "");
    this.host = parsed.host;
    this.hostname = parsed.hostname;
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
    const target = `${this.baseUrl}/${operation}`;
    const addresses = isIP(this.hostname)
      ? [{ address: this.hostname, family: isIP(this.hostname) }]
      : await lookup(this.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new Error("Facilitator DNS resolved outside the public network");
    }
    const response = await pinnedFetch(target, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      signal: AbortSignal.timeout(this.config.facilitatorTimeoutMs),
    }, addresses[0]!);
    const value = await this.readBoundedJson(response, 256_000);
    if (!response.ok) throw new Error(`Facilitator ${operation} rejected the request`);
    this.validateResponse(operation, value);
    return value as T;
  }

  private async readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
      throw new Error("Facilitator response media type is invalid");
    }
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
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
