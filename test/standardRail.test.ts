import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import {
  assertNoDuplicateJsonKeys,
  canonicalHash,
  canonicalJson,
  recipeNonce,
} from "../src/standardRail/canonical.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "../src/standardRail/schema.js";
import { assertTransition, isTerminalState } from "../src/standardRail/stateMachine.js";
import { isNonPublicAddress } from "../src/standardRail/network.js";
import { assertPassiveProviderOutput } from "../src/standardRail/providerOutput.js";
import {
  assertPaymentIdentifierExtension,
} from "../src/standardRail/payment.js";
import { standardPaymentError } from "../src/standardRail/routes.js";
import { standardRailError } from "../src/standardRail/errors.js";
import { hasFinalizedNonceConflict } from "../src/standardRail/nonceConflict.js";
import { providerOutcome } from "../src/standardRail/walletQueries.js";
import { isAdmissionWindowOpen } from "../src/standardRail/service.js";

describe("standard rail primitives", () => {
  it("detects a finalized nonce conflict across every configured source", () => {
    expect(hasFinalizedNonceConflict([12n, 12n], 11n)).toBe(true);
    expect(hasFinalizedNonceConflict([12n, 11n], 11n)).toBe(false);
    expect(hasFinalizedNonceConflict([12n], 11n)).toBe(true);
  });

  it("does not present an unrecorded provider outcome as completed", () => {
    expect(providerOutcome(0, false)).toBe("Pending");
    expect(providerOutcome(0, true)).toBe("Completed");
  });

  it("closes admission when either signed rail deadline expires", () => {
    expect(isAdmissionWindowOpen(200, 300, 199)).toBe(true);
    expect(isAdmissionWindowOpen(200, 300, 200)).toBe(false);
    expect(isAdmissionWindowOpen(400, 300, 300)).toBe(false);
  });

  it("maps only classified payment errors and never leaks internals", () => {
    expect(standardPaymentError(new Error("payer mismatch: secret upstream detail"))).toBeNull();
    expect(standardPaymentError(standardRailError("AUTHORIZATION_MISMATCH"))).toMatchObject({
      status: 400,
      code: "AUTHORIZATION_MISMATCH",
      phase: "payment_validation",
      retryable: true,
    });
  });
  it("canonicalizes object keys and hashes equivalent objects identically", () => {
    expect(canonicalJson({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
    expect(canonicalHash({ z: 1, a: [true, "x"] })).toBe(
      canonicalHash({ a: [true, "x"], z: 1 }),
    );
    expect(canonicalJson({ decimal: 0.1, negativeZero: -0 })).toBe(
      '{"decimal":0.1,"negativeZero":0}',
    );
    expect(() => canonicalJson({ invalid: "\ud800" })).toThrow(/invalid Unicode/);
    expect(() => canonicalJson({ ["\udc00"]: true })).toThrow(/invalid Unicode/);
  });

  it("rejects duplicate JSON keys at any nesting depth", () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":{"x":1,"x":2}}')).toThrow(/Duplicate JSON key x/);
  });

  it("requires the exact issued payment identifier", () => {
    const issued = {
      info: { required: true, id: "int_1234567890abcdef" },
      schema: { type: "object" },
    };
    expect(() => assertPaymentIdentifierExtension(issued, issued)).not.toThrow();
    expect(() => assertPaymentIdentifierExtension({
      ...issued,
      info: { required: true, id: "int_fedcba0987654321" },
    }, issued)).toThrow(/differs/);
    expect(() => assertPaymentIdentifierExtension({
      ...issued,
      info: { ...issued.info, authority: true },
    }, issued)).toThrow(/differs/);
  });

  it("derives a deterministic order-bound recipe nonce", () => {
    const base = {
      chainId: 84532,
      canonicalToken: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
      payer: getAddress("0x1111111111111111111111111111111111111111"),
      splitter: getAddress("0x2222222222222222222222222222222222222222"),
      grossAmount: 1_000_000n,
      listingManifestHash: `0x${"01".repeat(32)}` as Hex,
      providerOfferHash: `0x${"02".repeat(32)}` as Hex,
      quoteHash: `0x${"03".repeat(32)}` as Hex,
      canonicalRequestHash: `0x${"04".repeat(32)}` as Hex,
      orderNonce: `0x${"05".repeat(32)}` as Hex,
    };
    const nonce = recipeNonce(base);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recipeNonce({ ...base, grossAmount: 1_000_001n })).not.toBe(nonce);
  });

  it("enforces closed request schemas with full type validation", () => {
    const validate = compileClosedRequestSchema({
      type: "object",
      properties: { count: { type: "integer", minimum: 1 } },
      required: ["count"],
      additionalProperties: false,
    });
    expect(() => assertSchema(validate, { count: 2 })).not.toThrow();
    expect(() => assertSchema(validate, { count: "2" })).toThrow(/closed outcome schema/);
    expect(() => assertSchema(validate, { count: 2, extra: true })).toThrow(/closed outcome schema/);
    expect(() => compileClosedRequestSchema({
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
      additionalProperties: false,
    })).toThrow(/close object/);
    expect(() => compileClosedRequestSchema({
      type: "object",
      properties: { unconstrained: {} },
      additionalProperties: false,
    })).toThrow(/explicit type/);
    expect(() => compileClosedRequestSchema({
      type: "object",
      properties: { conditional: { anyOf: [{ type: "string" }, { type: "object" }] } },
      additionalProperties: false,
    })).toThrow(/unsupported keyword/);
  });

  it("rejects private, translated, and tunneled provider addresses", () => {
    for (const address of [
      "127.0.0.1", "169.254.169.254", "::1", "::127.0.0.1", "::ffff:10.0.0.1",
      "64:ff9b::a00:1", "2001::1", "2002:0a00:0001::1", "fc00::1", "fe80::1",
    ]) expect(isNonPublicAddress(address)).toBe(true);
    expect(isNonPublicAddress("8.8.8.8")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("enforces committed closed response schemas and rejects active content", () => {
    const validate = compileClosedResponseSchema({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    });
    expect(() => assertSchema(validate, { summary: "complete" }, "Response")).not.toThrow();
    expect(() => assertSchema(validate, { summary: "complete", extra: true }, "Response")).toThrow();
    expect(() => assertPassiveProviderOutput({ summary: "<script>alert(1)</script>" })).toThrow();
    expect(() => assertPassiveProviderOutput({ summary: "A plain https://example.test reference" })).not.toThrow();
  });

  it("forbids state-machine shortcuts and marks disposed orders terminal", () => {
    expect(() => assertTransition("DEPOSIT_FINAL", "FULFILLED")).toThrow(/Forbidden/);
    expect(() => assertTransition("DEPOSIT_FINAL", "RELEASE_FINAL")).not.toThrow();
    expect(isTerminalState("FULFILLED")).toBe(true);
    expect(isTerminalState("LEGAL_HOLD")).toBe(true);
  });

  it("rejects private, metadata, mapped, and documentation network destinations", () => {
    for (const address of [
      "127.0.0.1", "169.254.169.254", "10.0.0.1", "198.51.100.1",
      "203.0.113.1", "::1", "fd00:ec2::254", "::ffff:7f00:1",
    ]) expect(isNonPublicAddress(address)).toBe(true);
    expect(isNonPublicAddress("8.8.8.8")).toBe(false);
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false);
  });
});
