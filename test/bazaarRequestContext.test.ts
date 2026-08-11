import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bazaarIngressAgeSeconds,
  captureBazaarRequestContext,
  clearBazaarRequestContext,
  hasBazaarPaymentSignature,
  takeBazaarPaymentHeaders,
} from "../src/http/bazaarRequestContext.js";

describe("Bazaar pre-parser request context", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts bearer headers and preserves the first-ingress age", () => {
    const clock = vi.spyOn(process.hrtime, "bigint");
    clock.mockReturnValueOnce(10_000_000_000n);
    const request = {
      headers: {
        "payment-signature": "secret-payment",
        "x-payment": "legacy-secret",
      },
      rawHeaders: [
        "Content-Type", "application/json",
        "PAYMENT-SIGNATURE", "secret-payment",
        "X-PAYMENT", "legacy-secret",
      ],
    } as unknown as Request;

    captureBazaarRequestContext(request);
    expect(hasBazaarPaymentSignature(request)).toBe(true);
    expect(request.headers["payment-signature"]).toBeUndefined();
    expect(request.headers["x-payment"]).toBeUndefined();
    expect(request.rawHeaders).toContain("[REDACTED]");
    expect(request.rawHeaders).not.toContain("secret-payment");
    expect(request.rawHeaders).not.toContain("legacy-secret");
    expect(takeBazaarPaymentHeaders(request)).toEqual({
      paymentSignature: "secret-payment",
      legacyPaymentPresent: true,
    });
    expect(hasBazaarPaymentSignature(request)).toBe(false);

    clock.mockReturnValueOnce(12_000_000_001n);
    expect(bazaarIngressAgeSeconds(request)).toBe(3n);
    clearBazaarRequestContext(request);
    expect(takeBazaarPaymentHeaders(request)).toEqual({
      paymentSignature: undefined,
      legacyPaymentPresent: false,
    });
  });
});
