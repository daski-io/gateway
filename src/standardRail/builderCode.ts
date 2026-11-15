import type { Hex } from "viem";
import { logger } from "../util/logger.js";

/**
 * ERC-8021 transaction attribution, schema 0: a builder code appended to the
 * calldata of a transaction this gateway builds and signs, so Base attributes
 * the transaction to it. Contracts never read the trailing bytes.
 *
 *   suffix = ascii(codes) ‖ uint8(len(codes)) ‖ 0x00 ‖ 0x80218021802180218021802180218021
 *
 * Codes are comma-separated ASCII. The suffix is parsed from the end: the
 * 16-byte marker, the schema id, then for schema 0 the codes' length and
 * the codes.
 */
export const ERC8021_MARKER = "0x80218021802180218021802180218021" as const;
const MARKER = ERC8021_MARKER.slice(2);
/** Marker, schema id and codes length: the bytes after the codes. */
const TRAILER_BYTES = 18;
/** BASE_BUILDER_CODE: what Base issues, never a list. */
export const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
/** One code of a received suffix: printable ASCII, no space or comma. */
const CODE = /^[\x21-\x2b\x2d-\x7e]+$/;
const HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;

export interface AttributionSuffix {
  schemaId: 0;
  codes: string[];
  /** Bytes the suffix occupies at the end of the data. */
  byteLength: number;
}

/** The schema-0 suffix for one or more codes. */
export function encodeAttributionSuffix(codes: string | readonly string[]): Hex {
  const list = typeof codes === "string" ? [codes] : [...codes];
  if (list.length === 0 || list.some((code) => !CODE.test(code))) {
    throw new Error("ERC-8021 codes must be printable ASCII without spaces or commas");
  }
  const joined = list.join(",");
  if (joined.length > 255) throw new Error("ERC-8021 codes must total at most 255 bytes");
  const length = joined.length.toString(16).padStart(2, "0");
  return `0x${Buffer.from(joined, "ascii").toString("hex")}${length}00${MARKER}`;
}

/**
 * The schema-0 suffix that ends `data`, or null when `data` does not end
 * with one: no marker, another schema id, a length running past the data,
 * or a code that is empty or not printable ASCII.
 */
export function parseAttributionSuffix(data: Hex): AttributionSuffix | null {
  const hex = data.toLowerCase();
  if (!HEX_BYTES.test(hex) || !hex.endsWith(MARKER)) return null;
  const bytes = (hex.length - 2) / 2;
  if (bytes < TRAILER_BYTES + 1) return null;
  const at = (fromEnd: number) => Number.parseInt(hex.slice(hex.length - 2 * fromEnd, hex.length - 2 * (fromEnd - 1)), 16);
  if (at(17) !== 0) return null;
  const length = at(18);
  const byteLength = length + TRAILER_BYTES;
  if (length === 0 || byteLength > bytes) return null;
  const text = Buffer.from(hex.slice(hex.length - 2 * byteLength, hex.length - 2 * TRAILER_BYTES), "hex").toString("latin1");
  const codes = text.split(",");
  if (codes.some((code) => !CODE.test(code))) return null;
  return { schemaId: 0, codes, byteLength };
}

/**
 * Whether observed calldata is the expected calldata, alone or followed by
 * exactly one well-formed ERC-8021 schema-0 suffix (any codes) that consumes
 * every remaining byte. Anything else, truncated or extra bytes included,
 * does not match. Case-insensitive, as hex.
 */
export function matchesWithAttribution(observed: Hex, expected: Hex): boolean {
  const seen = observed.toLowerCase();
  const wanted = expected.toLowerCase();
  if (!HEX_BYTES.test(seen) || !HEX_BYTES.test(wanted)) return false;
  if (seen === wanted) return true;
  if (!seen.startsWith(wanted)) return false;
  const rest = `0x${seen.slice(wanted.length)}` as Hex;
  const suffix = parseAttributionSuffix(rest);
  return suffix !== null && suffix.byteLength === (rest.length - 2) / 2;
}

/** BASE_BUILDER_CODE: unset or empty is off; otherwise one Base builder code, or boot fails. */
export function parseBuilderCode(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!BUILDER_CODE_PATTERN.test(value)) {
    throw new Error("BASE_BUILDER_CODE must be 1 to 32 characters of a-z, 0-9 and _");
  }
  return value;
}

/**
 * The builder code this process appends to the transactions it signs. A
 * remote signer whose policy refuses an attributed request turns it off
 * until restart: attribution never costs a sale.
 */
export class BuilderAttribution {
  readonly suffix: Hex | null;
  private refusedBy: string | null = null;

  constructor(readonly code: string | null = null) {
    this.suffix = code === null ? null : encodeAttributionSuffix(code);
  }

  /** The suffix to append now: none when no code is configured or a signer refused it. */
  current(): Hex | null {
    return this.refusedBy === null ? this.suffix : null;
  }

  /** Whether transaction data ends with this process's suffix. */
  carries(data: Hex | undefined): boolean {
    if (this.suffix === null || !data) return false;
    return data.length > this.suffix.length && data.toLowerCase().endsWith(this.suffix.slice(2));
  }

  /** Stops attributing until restart; logs once, naming the role whose signer refused. */
  refuse(role: string, reason: string): void {
    if (this.refusedBy !== null) return;
    this.refusedBy = role;
    logger.error("builder code refused by the signer policy; transactions are sent without it until restart", {
      role, builderCode: this.code, reason,
    });
  }
}
