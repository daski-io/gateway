import type { Hex } from "../types.js";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const CONFIRMATION_CODE = {
  Confirmed: 1,
  NotConfirmed: 2,
} as const;

export type ConfirmationLabel = keyof typeof CONFIRMATION_CODE;

export function isHexAddress(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function decodeBase64JsonObject(
  header: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
