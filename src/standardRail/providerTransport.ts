import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { activeRequestSignal } from "../mcp/requestContext.js";
import { createPinnedLookup } from "./facilitator.js";
import { isNonPublicAddress } from "./network.js";
import type { StandardListing } from "./types.js";

export interface ProviderFetchOptions {
  /** Only pre-durable reads and validation calls may follow client disconnects. */
  requestScoped?: boolean;
}

export async function assertPublicProviderEndpoint(
  profileOrigin: string,
  endpoint: string,
): Promise<void> {
  const origin = new URL(profileOrigin);
  const target = new URL(endpoint);
  if (target.origin !== origin.origin) {
    throw new Error("PROVIDER_ENDPOINT_ORIGIN_MISMATCH");
  }
  const addresses = isIP(target.hostname)
    ? [{ address: target.hostname }]
    : await lookup(target.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
  }
}

export async function pinnedProviderFetch(
  endpoint: string,
  init: RequestInit,
  addresses: Array<{ address: string; family?: number }>,
): Promise<Response> {
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("PROVIDER_REQUEST_BODY_INVALID");
  }
  const selected = addresses[0];
  if (!selected) throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
  return new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = httpsRequest(endpoint, {
      method: init.method,
      headers,
      signal: init.signal ?? undefined,
      lookup: createPinnedLookup({
        address: selected.address,
        family: selected.family === 6 ? 6 : 4,
      }),
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
          responseHeaders.append(name, String(item));
        }
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

export class StandardProviderTransport {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async fetch(
    listing: StandardListing,
    endpoint: string,
    init: RequestInit,
    options: ProviderFetchOptions = {},
  ): Promise<Response> {
    await assertPublicProviderEndpoint(
      listing.providerControlProfile.payload.origin,
      endpoint,
    );
    const signal = options.requestScoped && init.signal
      ? activeRequestSignal(init.signal)
      : init.signal;
    const scopedInit = signal ? { ...init, signal } : init;
    if (this.fetchFn !== fetch) return this.fetchFn(endpoint, scopedInit);
    const hostname = new URL(endpoint).hostname;
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new Error("PROVIDER_ENDPOINT_DNS_REJECTED");
    }
    return pinnedProviderFetch(endpoint, scopedInit, addresses);
  }
}
