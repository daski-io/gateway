import { describe, expect, it } from "vitest";
import {
  canonicalJsonStringify,
  computeRequestHash,
} from "../src/auth/envelope.js";

describe("signed request canonicalization", () => {
  it("is deterministic for nested objects", () => {
    expect(canonicalJsonStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the unsafe key %s at any depth",
    (key) => {
      const args = JSON.parse(
        `{"safe":true,"nested":{"${key}":{"role":"admin"}}}`,
      ) as Record<string, unknown>;
      expect(() => computeRequestHash(args)).toThrow(
        `unsafe object key in signed JSON: ${key}`,
      );
    },
  );

  it("does not allow distinct prototype payloads to share a hash", () => {
    const first = JSON.parse(
      '{"safe":2,"__proto__":{"role":"user"}}',
    ) as Record<string, unknown>;
    const second = JSON.parse(
      '{"safe":2,"__proto__":{"role":"admin"}}',
    ) as Record<string, unknown>;
    expect(() => computeRequestHash(first)).toThrow();
    expect(() => computeRequestHash(second)).toThrow();
  });
});
