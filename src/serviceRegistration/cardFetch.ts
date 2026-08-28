import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertNoDuplicateJsonKeys } from "../standardRail/canonical.js";
import { isNonPublicAddress } from "../standardRail/network.js";
import { pinnedProviderFetch } from "../standardRail/providerTransport.js";

const MAXIMUM_CARD_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function validatedCardUrl(raw: string): URL {
  const value = new URL(raw);
  if (
    value.protocol !== "https:" || value.username || value.password ||
    value.hash || value.href.length > 2_048
  ) throw new Error("AgentCard URL must be credential-free HTTPS");
  return value;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_CARD_BYTES)
  ) throw new Error("AgentCard response is too large");
  if (!response.body) throw new Error("AgentCard response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > MAXIMUM_CARD_BYTES) {
      await reader.cancel();
      throw new Error("AgentCard response is too large");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function fetchProviderCardJson(
  rawUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const url = validatedCardUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timeout.unref();
  try {
    let response: Response;
    if (fetchFn !== fetch) {
      response = await fetchFn(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } else {
      const addresses = isIP(url.hostname)
        ? [{ address: url.hostname, family: isIP(url.hostname) }]
        : await lookup(url.hostname, { all: true, verbatim: true });
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isNonPublicAddress(address))
      ) throw new Error("AgentCard endpoint does not resolve to public addresses");
      response = await pinnedProviderFetch(url.toString(), {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      }, addresses);
    }
    if (response.status !== 200) throw new Error("AgentCard endpoint did not return 200");
    const mediaType = response.headers.get("content-type")
      ?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      mediaType !== "application/json" &&
      !mediaType?.endsWith("+json")
    ) throw new Error("AgentCard endpoint must return JSON");
    const bytes = await boundedBody(response);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonKeys(text);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}
