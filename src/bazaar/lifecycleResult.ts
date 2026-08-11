import { canonicalJsonStringify } from "../auth/envelope.js";
import type { Hex } from "../types.js";
import { isHex32 } from "../util/evmValidation.js";

export function parseLifecycleActionResult(
  value: unknown,
  assertionNonce: Hex,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).sort().join("\0") !==
      ["assertionNonce", "result"].sort().join("\0") ||
    !isHex32(response.assertionNonce) ||
    response.assertionNonce.toLowerCase() !== assertionNonce.toLowerCase() ||
    response.result === null || typeof response.result !== "object" ||
    Array.isArray(response.result)
  ) return null;
  return response.result as Record<string, unknown>;
}

export function boundedLifecycleResult(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const json = canonicalJsonStringify(value);
  if (Buffer.byteLength(json, "utf8") > 64 * 1024) {
    throw new Error("Bazaar lifecycle response exceeded its size limit");
  }
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bazaar lifecycle response was not an object");
  }
  return parsed as Record<string, unknown>;
}
