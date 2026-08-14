import { assertNoDuplicateJsonKeys } from "./canonical.js";

export async function readBoundedJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (mediaType !== "application/json" || (encoding && encoding !== "identity")) {
    throw new Error("BOUNDED_JSON_MEDIA_TYPE_INVALID");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
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
