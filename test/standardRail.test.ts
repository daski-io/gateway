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
import { assertRefundNetworkFee } from "../src/standardRail/evidence.js";
import {
  buildGrossRefundIntent,
  validateGrossRefundIntent,
} from "../src/standardRail/refund.js";
import {
  assertPaymentIdentifierExtension,
} from "../src/standardRail/payment.js";
import { declarePaymentIdentifierExtension } from "@x402/extensions/payment-identifier";

describe("standard rail primitives", () => {
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

  it("accepts only a closed non-authoritative payment identifier mutation", () => {
    const issued = declarePaymentIdentifierExtension(false);
    expect(() => assertPaymentIdentifierExtension({
      ...issued,
      info: { required: false, id: "pay_1234567890abcd" },
    }, issued)).not.toThrow();
    expect(() => assertPaymentIdentifierExtension({
      ...issued,
      info: { required: false, id: "too-short" },
    }, issued)).toThrow(/invalid/);
    expect(() => assertPaymentIdentifierExtension({
      ...issued,
      info: { required: false, id: "pay_1234567890abcd", authority: true },
    }, issued)).toThrow(/open shape/);
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
    expect(isTerminalState("REFUNDED")).toBe(true);
    expect(isTerminalState("LEGAL_HOLD")).toBe(true);
  });

  it("builds one exact-gross refund and rejects inconsistent contributions", () => {
    const input = {
      orderId: "ord_00000000-0000-4000-8000-000000000000",
      payer: "0x1111111111111111111111111111111111111111" as Hex,
      token: "0x2222222222222222222222222222222222222222" as Hex,
      grossAmount: "1000",
      providerAmount: "950",
      daskiAmount: "50",
      providerReservationId: `0x${"04".repeat(32)}` as Hex,
      daskiReservationId: `0x${"05".repeat(32)}` as Hex,
      refundReason: "provider_failed" as const,
      depositEvidenceHash: `0x${"06".repeat(32)}` as Hex,
      releaseEvidenceHash: `0x${"07".repeat(32)}` as Hex,
      refundPolicyHash: `0x${"08".repeat(32)}` as Hex,
      dispositionEvidenceHash: `0x${"03".repeat(32)}` as Hex,
      dueAt: 2_000_000_000,
    };
    const intent = buildGrossRefundIntent(input);
    expect(intent).toMatchObject({ amount: "1000", leg: "gross" });
    expect(validateGrossRefundIntent(intent, {
      orderId: input.orderId,
      payer: input.payer,
      token: input.token,
      grossAmount: input.grossAmount,
      providerAmount: input.providerAmount,
      daskiAmount: input.daskiAmount,
      providerReservationId: input.providerReservationId,
      daskiReservationId: input.daskiReservationId,
      depositEvidenceHash: input.depositEvidenceHash,
      releaseEvidenceHash: input.releaseEvidenceHash,
      refundPolicyHash: input.refundPolicyHash,
    })).toEqual(intent);
    expect(() => validateGrossRefundIntent(
      { ...intent, refundReason: "buyer_requested" },
      {
        orderId: input.orderId,
        payer: input.payer,
        token: input.token,
        grossAmount: input.grossAmount,
        providerAmount: input.providerAmount,
        daskiAmount: input.daskiAmount,
        providerReservationId: input.providerReservationId,
        daskiReservationId: input.daskiReservationId,
        depositEvidenceHash: input.depositEvidenceHash,
        releaseEvidenceHash: input.releaseEvidenceHash,
        refundPolicyHash: input.refundPolicyHash,
      },
    )).toThrow(/conflicts/);
    expect(() => buildGrossRefundIntent({ ...input, daskiAmount: "51" })).toThrow(/exact gross/);
  });

  it("rejects refund transactions above the signed network-fee ceiling", () => {
    expect(() => assertRefundNetworkFee({
      gas: 60_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maximumNetworkFee: 120_000_000_000_000n,
    })).not.toThrow();
    expect(() => assertRefundNetworkFee({
      gas: 60_000n,
      maxFeePerGas: 2_000_000_001n,
      maxPriorityFeePerGas: 1_000_000_000n,
      maximumNetworkFee: 120_000_000_000_000n,
    })).toThrow(/network-fee ceiling/);
    expect(() => assertRefundNetworkFee({
      gas: 60_000n,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      maximumNetworkFee: 120_000_000_000_000n,
    })).toThrow(/network-fee ceiling/);
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
