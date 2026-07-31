import { readBoundedJson, safeFetch } from "../util/urlSafety.js";
import type { ProviderLegalMetadata } from "./types.js";
import { parseHttpsUrl, parseProviderLegalMetadata } from "./validation.js";

const REGISTRATION_MAX_BYTES = 256 * 1024;
const REACHABILITY_TIMEOUT_MS = 10_000;

export type LegalReachabilityFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

async function fetchReachable(
  rawUrl: string,
  field: string,
  fetchFn: LegalReachabilityFetch,
): Promise<void> {
  let url = parseHttpsUrl(rawUrl, field);
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location || attempt === 1) {
          throw new Error(`${field} has an unusable redirect`);
        }
        url = parseHttpsUrl(new URL(location, url).toString(), field);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${field} returned HTTP ${response.status}`);
      }
      await response.body?.cancel().catch(() => undefined);
      return;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function validateProviderLegalReachability(
  registrationUrl: string,
  fetchFn: LegalReachabilityFetch = safeFetch,
): Promise<ProviderLegalMetadata> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  let legal: ProviderLegalMetadata;
  try {
    const response = await fetchFn(registrationUrl, {
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`registration URL returned HTTP ${response.status}`);
    }
    const registration = await readBoundedJson<Record<string, unknown>>(
      response,
      REGISTRATION_MAX_BYTES,
    );
    legal = parseProviderLegalMetadata(registration);
  } finally {
    clearTimeout(timer);
  }
  await fetchReachable(legal.termsUrl, "termsUrl", fetchFn);
  await fetchReachable(legal.privacyUrl, "privacyUrl", fetchFn);
  return legal;
}
