import type { Hex } from "../types.js";
import { sanitizeForLlmReflection } from "../util/sanitize.js";

export function buildBuyerAgentURI(walletAddress: Hex, name?: string): string {
  const lower = walletAddress.toLowerCase();
  const resolvedName = name ?? `buyer-${lower.slice(-6)}`;
  const card = {
    name: resolvedName,
    type: "buyer",
    wallet: lower,
    endpoints: {},
  };
  const base64 = Buffer.from(JSON.stringify(card)).toString("base64");
  return `data:application/json;base64,${base64}`;
}

export function defaultBuyerName(walletAddress: Hex): string {
  return `buyer-${walletAddress.toLowerCase().slice(-6)}`;
}

const BUYER_NAME_MAX_LENGTH = 64;

export type SanitizedBuyerName = { ok: true; name: string } | { ok: false; error: string };

export function sanitizeBuyerName(raw: unknown): SanitizedBuyerName {
  if (typeof raw !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "name must not be empty" };
  }
  if (trimmed.length > BUYER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `name must be ${BUYER_NAME_MAX_LENGTH} characters or fewer`,
    };
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return {
        ok: false,
        error: "name must not contain control characters",
      };
    }
  }
  const sanitized = sanitizeForLlmReflection(trimmed, {
    stringMax: BUYER_NAME_MAX_LENGTH,
    maxDepth: 0,
  });
  if (sanitized.length === 0) {
    return { ok: false, error: "name must contain visible characters" };
  }
  return { ok: true, name: sanitized };
}
