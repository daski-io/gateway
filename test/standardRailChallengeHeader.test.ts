import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentRequired } from "@x402/core/types";
import {
  encodedPaymentRequiredHeader,
  PAYMENT_REQUIRED_HEADER_BUDGET,
} from "../src/standardRail/payment.js";
import { createStandardRailRouter, standardPaymentError } from "../src/standardRail/routes.js";
import type { StandardRailService } from "../src/standardRail/service.js";

const RAIL_PROFILE_HASH = `0x${"ab".repeat(32)}`;

function challengeFixture(overrides?: {
  bazaarInfo?: Record<string, unknown>;
  terms?: Record<string, unknown>;
}): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url: "https://gateway.example/outcomes/8327/form-entity",
      description: "Daski outcome form-entity",
      mimeType: "application/json",
      serviceName: "form-entity",
    },
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "46800000",
      payTo: "0x0Cb9C9f225354608915A3f337261C4F64C6713E4",
      maxTimeoutSeconds: 179,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    }],
    extensions: {
      "payment-identifier": { info: { required: false }, schema: { type: "object" } },
      bazaar: {
        info: overrides?.bazaarInfo ?? { input: { type: "object" }, output: { type: "object" } },
      },
      "daski-order-binding": {
        version: 2,
        profile: "recipe-bound-v2",
        runtimeCommitmentHash: `0x${"11".repeat(32)}`,
        providerIntentHash: `0x${"22".repeat(32)}`,
        quoteHash: `0x${"33".repeat(32)}`,
        canonicalRequestHash: `0x${"44".repeat(32)}`,
        orderNonce: `0x${"55".repeat(32)}`,
        expiresAt: 1_788_032_322,
      },
      "daski-rail-profile": { hash: RAIL_PROFILE_HASH },
      "daski-order-terms": overrides?.terms ?? {
        providerLegalName: "Example Provider LLC",
        commissionBps: 500,
      },
    },
  };
}

// Mimics the 2026-08-27 schema rebase: the inlined outcome schemas push the
// complete encoded challenge past Node's 16 KiB response-header ceiling.
function oversizedBazaarInfo(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < 220; index += 1) {
    properties[`field${index}`] = {
      type: "object",
      required: ["line1", "city", "state", "postalCode", "country"],
      properties: {
        line1: { type: "string", maxLength: 512, minLength: 1 },
        city: { type: "string", maxLength: 256, minLength: 1 },
        state: { type: "string", maxLength: 128, minLength: 1 },
        postalCode: { type: "string", maxLength: 64, minLength: 1 },
        country: { type: "string", maxLength: 2, minLength: 1 },
      },
    };
  }
  return { input: { type: "object", properties }, output: { type: "object" } };
}

function decodeHeader(value: string): PaymentRequired {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as PaymentRequired;
}

describe("encodedPaymentRequiredHeader", () => {
  it("mirrors a challenge inside the budget completely", () => {
    const challenge = challengeFixture();
    const header = encodedPaymentRequiredHeader(challenge);
    expect(header).not.toBeNull();
    expect(header!.length).toBeLessThanOrEqual(PAYMENT_REQUIRED_HEADER_BUDGET);
    expect(decodeHeader(header!)).toEqual(challenge);
  });

  it("drops only the bazaar declaration from an oversized challenge", () => {
    const challenge = challengeFixture({ bazaarInfo: oversizedBazaarInfo() });
    expect(
      Buffer.from(JSON.stringify(challenge)).toString("base64url").length,
    ).toBeGreaterThan(PAYMENT_REQUIRED_HEADER_BUDGET);
    const header = encodedPaymentRequiredHeader(challenge);
    expect(header).not.toBeNull();
    expect(header!.length).toBeLessThanOrEqual(PAYMENT_REQUIRED_HEADER_BUDGET);
    const decoded = decodeHeader(header!);
    expect(decoded.extensions).not.toHaveProperty("bazaar");
    expect(decoded).toEqual({
      ...challenge,
      extensions: Object.fromEntries(Object.entries(challenge.extensions!)
        .filter(([key]) => key !== "bazaar")),
    });
  });

  it("returns null when even the compact challenge exceeds the budget", () => {
    const challenge = challengeFixture({
      terms: { providerLegalName: "x".repeat(9_000) },
    });
    expect(encodedPaymentRequiredHeader(challenge)).toBeNull();
  });
});

describe("standard rail challenge transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function listen(challenge: PaymentRequired): Promise<string> {
    const service = {
      railProfileHash: RAIL_PROFILE_HASH,
      issueChallenge: vi.fn(async () => ({
        handle: "handle-1",
        order: { orderId: "order-1" },
        paymentRequired: challenge,
      })),
    } as unknown as StandardRailService;
    const app = express();
    app.use(createStandardRailRouter(service, "https://gateway.example"));
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", (error?: Error) =>
        error ? reject(error) : resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener unavailable");
    return `http://127.0.0.1:${address.port}/outcomes/8327/form-entity`;
  }

  it("keeps an oversized challenge readable by a default Node fetch client", async () => {
    const challenge = challengeFixture({ bazaarInfo: oversizedBazaarInfo() });
    // Node's own fetch enforces undici's 16 KiB header ceiling, so this
    // request is the exact failure mode seen on the deployed gateway.
    const response = await fetch(await listen(challenge), { method: "POST" });

    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("daski-order-handle")).toBe("handle-1");
    expect(response.headers.get("daski-rail-profile-hash")).toBe(RAIL_PROFILE_HASH);
    expect(response.headers.get("daski-rail-profile")).toBe(
      `https://gateway.example/public/v2/artifacts/${RAIL_PROFILE_HASH}`,
    );
    const header = response.headers.get("payment-required");
    expect(header).not.toBeNull();
    expect(header!.length).toBeLessThanOrEqual(PAYMENT_REQUIRED_HEADER_BUDGET);
    expect(decodeHeader(header!).extensions).not.toHaveProperty("bazaar");
    // The body always carries the complete challenge, discovery included.
    expect(await response.json()).toEqual(challenge);
  });

  it("mirrors a small challenge into the header unchanged", async () => {
    const challenge = challengeFixture();
    const response = await fetch(await listen(challenge), { method: "POST" });

    expect(response.status).toBe(402);
    const header = response.headers.get("payment-required");
    expect(header).not.toBeNull();
    expect(decodeHeader(header!)).toEqual(challenge);
    expect(await response.json()).toEqual(challenge);
  });

  it("omits the header rather than emit an unreadable response", async () => {
    const challenge = challengeFixture({
      terms: { providerLegalName: "x".repeat(9_000) },
    });
    const response = await fetch(await listen(challenge), { method: "POST" });

    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeNull();
    expect(response.headers.get("daski-order-handle")).toBe("handle-1");
    expect(await response.json()).toEqual(challenge);
  });
});

describe("standard payment error mapping", () => {
  it("answers a provider quote decline as a conflict", () => {
    expect(standardPaymentError(new Error("PROVIDER_QUOTE_REJECTED"))).toEqual({
      status: 409,
      code: "PROVIDER_QUOTE_REJECTED",
      message: "The provider declined to quote this request",
    });
  });

  it("answers an expired offer as a retryable conflict", () => {
    expect(standardPaymentError(new Error("OUTCOME_OFFER_EXPIRED"))).toMatchObject({
      status: 409,
      code: "OUTCOME_OFFER_EXPIRED",
    });
  });

  it("answers unusable provider quotes as an upstream failure", () => {
    for (const internal of [
      "PROVIDER_QUOTE_UNAVAILABLE",
      "PROVIDER_QUOTE_INVALID",
      "PROVIDER_QUOTE_SIGNATURE_INVALID",
      "PROVIDER_QUOTE_NOT_RELEASABLE",
    ]) {
      expect(standardPaymentError(new Error(internal))).toMatchObject({
        status: 502,
        code: "PROVIDER_QUOTE_UNAVAILABLE",
      });
    }
  });

  it("keeps unknown internals unmapped", () => {
    expect(standardPaymentError(new Error("SOMETHING_ELSE"))).toBeNull();
  });
});
