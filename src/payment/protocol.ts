export { isHex32, isHexAddress } from "../util/evmValidation.js";

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
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
