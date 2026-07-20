import type { Hex } from "../types.js";

export const HEX_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const HEX_BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function isHexAddress(value: unknown): value is Hex {
  return typeof value === "string" && HEX_ADDRESS_PATTERN.test(value);
}

export function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && HEX_BYTES32_PATTERN.test(value);
}

export function isHexBytes(value: unknown): value is Hex {
  return (
    typeof value === "string" &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
    value.length >= 4
  );
}

export function isHexSignature(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{130}$/.test(value);
}
