import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { assertNoDuplicateJsonKeys } from "./canonical.js";
import { isNonPublicAddress } from "./network.js";

export function normalizeCallbackUrl(input: string): { canonical: string; displayOrigin: string } {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("NOTIFICATION_CALLBACK_INVALID");
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") url.port = "";
  const canonical = url.toString();
  return { canonical, displayOrigin: url.origin };
}

export async function resolvePublicCallback(input: string) {
  const url = new URL(input);
  const addresses = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) }] :
    await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isNonPublicAddress(item.address))) {
    throw new Error("NOTIFICATION_CALLBACK_INVALID");
  }
  return addresses;
}

export async function postPinnedJson(args: {
  url: string;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
  responseMode?: "json" | "ignore";
}): Promise<{ status: number; value: unknown }> {
  const addresses = await resolvePublicCallback(args.url);
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(args.url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(args.body) },
      signal: AbortSignal.timeout(args.timeoutMs),
      lookup: (_hostname, _options, callback) => callback(
        null,
        selected.address,
        selected.family === 6 ? 6 : 4,
      ),
    }, (response) => {
      const mediaType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (args.responseMode !== "ignore" &&
        (mediaType !== "application/json" || (encoding && encoding !== "identity"))) {
        response.destroy();
        reject(new Error("NOTIFICATION_RESPONSE_INVALID"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > args.maxResponseBytes) {
          response.destroy(new Error("NOTIFICATION_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          if (args.responseMode === "ignore") {
            resolve({ status: response.statusCode ?? 500, value: null });
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          assertNoDuplicateJsonKeys(text);
          resolve({ status: response.statusCode ?? 500, value: text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.write(args.body);
    request.end();
  });
}
