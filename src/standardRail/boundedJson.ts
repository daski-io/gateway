import { assertNoDuplicateJsonKeys } from "./canonical.js";

/**
 * Releases a response the caller will not read. The pinned provider
 * transport wraps a live socket in the Response body; a body that is never
 * consumed or cancelled keeps that socket (and the keep-alive slot) open
 * until the peer closes it, which a hostile provider never does.
 */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The stream may already be closed or errored; nothing is left to release.
  }
}

export async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    await discardResponseBody(response);
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await discardResponseBody(response);
    throw new Error("BOUNDED_JSON_TOO_LARGE");
  }
  if (!response.body) throw new Error("BOUNDED_JSON_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("BOUNDED_JSON_TOO_LARGE");
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}
