import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import {
  BuilderAttribution,
  encodeAttributionSuffix,
  ERC8021_MARKER,
  matchesWithAttribution,
  parseAttributionSuffix,
  parseBuilderCode,
} from "../src/standardRail/builderCode.js";
import { logger } from "../src/util/logger.js";

// Golden vectors: Base's documentation example and Daski's own code.
const BASE_DOCS = { code: "bc_b7k3p9da", suffix: "0x62635f62376b33703964610b0080218021802180218021802180218021" as Hex };
const DASKI = { code: "bc_0h3q8lqm", suffix: "0x62635f30683371386c716d0b0080218021802180218021802180218021" as Hex };
const CALL = "0x8a4adf24" as Hex;

afterEach(() => { vi.restoreAllMocks(); });

describe("ERC-8021 schema-0 suffix", () => {
  it("encodes both golden vectors byte for byte", () => {
    expect(encodeAttributionSuffix(BASE_DOCS.code)).toBe(BASE_DOCS.suffix);
    expect(encodeAttributionSuffix(DASKI.code)).toBe(DASKI.suffix);
    expect((DASKI.suffix.length - 2) / 2).toBe(29);
    expect(DASKI.suffix.endsWith(ERC8021_MARKER.slice(2))).toBe(true);
  });

  it("parses both golden vectors from the end of calldata", () => {
    for (const { code, suffix } of [BASE_DOCS, DASKI]) {
      expect(parseAttributionSuffix(`${CALL}${suffix.slice(2)}` as Hex)).toEqual({ schemaId: 0, codes: [code], byteLength: 29 });
      expect(parseAttributionSuffix(suffix)).toEqual({ schemaId: 0, codes: [code], byteLength: 29 });
    }
    expect(parseAttributionSuffix(DASKI.suffix.toUpperCase().replace("0X", "0x") as Hex)?.codes).toEqual([DASKI.code]);
  });

  it("encodes and parses several comma-separated codes", () => {
    const suffix = encodeAttributionSuffix([BASE_DOCS.code, DASKI.code]);
    expect(parseAttributionSuffix(suffix)).toEqual({ schemaId: 0, codes: [BASE_DOCS.code, DASKI.code], byteLength: 41 });
    expect(() => encodeAttributionSuffix([])).toThrow();
    expect(() => encodeAttributionSuffix("a,b")).toThrow();
    expect(() => encodeAttributionSuffix("has space")).toThrow();
    expect(() => encodeAttributionSuffix("x".repeat(256))).toThrow();
  });

  it("finds no suffix without the marker, with another schema, or with a malformed length or code", () => {
    const body = DASKI.suffix.slice(2);
    expect(parseAttributionSuffix(CALL)).toBeNull();
    expect(parseAttributionSuffix(`0x${body.slice(0, -2)}20` as Hex)).toBeNull(); // marker damaged
    expect(parseAttributionSuffix(`0x${body.slice(0, 24)}01${body.slice(26)}` as Hex)).toBeNull(); // schema 1
    expect(parseAttributionSuffix(`0x${body.slice(0, 22)}ff${body.slice(24)}` as Hex)).toBeNull(); // length past the data
    expect(parseAttributionSuffix(`0x${body.slice(0, 22)}00${body.slice(24)}` as Hex)).toBeNull(); // no codes
    expect(parseAttributionSuffix(`0x${"00".repeat(11)}0b00${ERC8021_MARKER.slice(2)}` as Hex)).toBeNull(); // not ASCII
    expect(parseAttributionSuffix(encodeAttributionSuffix("a").replace("61", "2c") as Hex)).toBeNull(); // empty codes
    expect(parseAttributionSuffix(`0x${ERC8021_MARKER.slice(2)}` as Hex)).toBeNull(); // too short
    expect(parseAttributionSuffix("0x123" as Hex)).toBeNull();
  });
});

describe("matchesWithAttribution", () => {
  const expected = `${CALL}${"00".repeat(31)}01` as Hex;

  it("accepts the expected calldata exactly, in any case", () => {
    expect(matchesWithAttribution(expected, expected)).toBe(true);
    expect(matchesWithAttribution(expected.toUpperCase().replace("0X", "0x") as Hex, expected)).toBe(true);
  });

  it("accepts the expected calldata followed by one well-formed suffix of any codes", () => {
    for (const suffix of [DASKI.suffix, BASE_DOCS.suffix, encodeAttributionSuffix(["other", "codes"])]) {
      expect(matchesWithAttribution(`${expected}${suffix.slice(2)}` as Hex, expected)).toBe(true);
    }
  });

  it("refuses anything else: other calldata, garbage, truncation, extra bytes, other schemas, two suffixes", () => {
    const body = DASKI.suffix.slice(2);
    const refused = [
      `${CALL}${"00".repeat(31)}02`, // different calldata
      `${expected}00`, // one extra byte
      `${expected}${"ab".repeat(29)}`, // garbage of the suffix's length
      `${expected}${body.slice(0, -2)}`, // truncated suffix
      `${expected}00${body}`, // a byte before the suffix
      `${expected}${body}00`, // a byte after the marker
      `${expected}${body.slice(0, 24)}01${body.slice(26)}`, // schema id 1
      `${expected}${body}${body}`, // two suffixes
      expected.slice(0, -2), // shorter than expected
      `${expected.slice(0, -2)}${body}`, // suffix replacing the last expected byte
      `${expected}${body}0`, // odd hex
    ] as Hex[];
    for (const observed of refused) expect(matchesWithAttribution(observed, expected), observed).toBe(false);
    // The suffix must consume every remaining byte: a code that swallows the
    // expected tail is not a match either.
    expect(matchesWithAttribution(`${CALL}${body}` as Hex, `${CALL}62` as Hex)).toBe(false);
  });
});

describe("BASE_BUILDER_CODE", () => {
  it("is off when unset or empty and otherwise one Base builder code", () => {
    expect(parseBuilderCode(undefined)).toBeNull();
    expect(parseBuilderCode("")).toBeNull();
    expect(parseBuilderCode("  ")).toBeNull();
    expect(parseBuilderCode(DASKI.code)).toBe(DASKI.code);
    expect(parseBuilderCode("a".repeat(32))).toBe("a".repeat(32));
    for (const value of ["BC_0H3Q8LQM", "bc-0h3q8lqm", "bc,0h3q8lqm", "a".repeat(33), "bc 1", "bç"]) {
      expect(() => parseBuilderCode(value), value).toThrow("BASE_BUILDER_CODE must be 1 to 32 characters of a-z, 0-9 and _");
    }
  });

  it("appends nothing when off, and stops for good on the first refusal, logging once", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const off = new BuilderAttribution();
    expect(off.current()).toBeNull();
    expect(off.carries(`${CALL}${DASKI.suffix.slice(2)}` as Hex)).toBe(false);

    const on = new BuilderAttribution(DASKI.code);
    expect(on.current()).toBe(DASKI.suffix);
    expect(on.carries(`${CALL}${DASKI.suffix.slice(2)}` as Hex)).toBe(true);
    expect(on.carries(`${CALL}${BASE_DOCS.suffix.slice(2)}` as Hex)).toBe(false);
    expect(on.carries(CALL)).toBe(false);
    on.refuse("sender", "HTTP_403");
    on.refuse("sender", "HTTP_403");
    expect(on.current()).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("builder code refused by the signer policy"),
      { role: "sender", builderCode: DASKI.code, reason: "HTTP_403" });
  });
});
