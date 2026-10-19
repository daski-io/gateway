import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import { TransactionOutcomeUnknownError } from "../src/db/transientTransaction.js";
import { StandardRailError, standardRailPublicError } from "../src/standardRail/errors.js";
import { paymentAdmissionFailure } from "../src/standardRail/paymentAdmission.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";
import { logger } from "../src/util/logger.js";
import { hash, payer, purchaseHarness } from "./helpers/purchaseResponseFixture.js";

// Keep the real admission, replay and claim-failure path; signature
// cryptography and external systems have their own contract tests.
vi.mock("../src/standardRail/payment.js", async (original) => ({
  ...await original<typeof import("../src/standardRail/payment.js")>(),
  validatePayment: vi.fn(async () => ({ payer, nonce: hash("3"), authorizationKey: hash("9") })),
}));
vi.mock("../src/standardRail/reputationEligibility.js", () => ({ isReputationEligiblePayer: () => true }));
vi.mock("../src/standardRail/reputationOrders.js", () => ({ buildReputationRegistration: async () => ({}) }));
afterEach(() => { vi.restoreAllMocks(); });

const serialization = () => Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
const context = (current: StandardOrderRecord | null | "unread" = null) => ({
  orderId: "order-1", intentId: "int_12345678-1234-4123-8123-123456789abc",
  paymentPayloadHash: hash("a"), current,
});
const answer = (error: unknown) => {
  const mapped = paymentAdmissionFailure(error, context());
  expect(mapped).toBeInstanceOf(StandardRailError);
  return mapped as StandardRailError;
};

describe("paymentAdmissionFailure", () => {
  it("answers a claim the database did not commit with a retryable no-settlement 503", () => {
    for (const error of [
      serialization(),
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
      Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
      new Error("Connection terminated unexpectedly"),
      new Error("timeout exceeded when trying to connect"),
    ]) {
      expect(answer(error)).toMatchObject({
        code: "PAYMENT_ADMISSION_UNAVAILABLE", status: 503, phase: "payment_validation",
        retryable: true, requiresNewSignature: false, paymentMayHaveSettled: false,
        nextAction: "Wait for Retry-After, then resend the identical signed purchase; do not sign again. " +
          "Nothing was claimed or settled.",
      });
    }
    expect(answer(serialization()).logContext).toMatchObject({ sqlstate: "40001", orderId: "order-1" });
  });

  it("never reads a lost COMMIT as nothing claimed", () => {
    const lost = new TransactionOutcomeUnknownError("standard_rail.claim_authorization",
      new Error("Connection terminated unexpectedly"));
    expect(answer(lost)).toMatchObject({
      code: "PAYMENT_PENDING_RECONCILIATION", paymentMayHaveSettled: true, requiresNewSignature: false,
      phase: "payment_validation",
    });
  });

  it("names each claim refusal with the wire code of the same condition", () => {
    expect(answer(new Error("OUTCOME_CAPACITY_EXHAUSTED"))).toMatchObject({
      code: "OUTCOME_CAPACITY_EXHAUSTED", status: 409, retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: false,
    });
    expect(answer(new Error("PAYMENT_AUTHORIZATION_ALREADY_CLAIMED"))).toMatchObject({
      code: "PAYMENT_IDENTIFIER_CONFLICT", status: 409, paymentMayHaveSettled: true, field: "payment-identifier",
    });
    expect(answer(new Error("READINESS_PAYER_MISMATCH"))).toMatchObject({
      code: "AUTHORIZATION_MISMATCH", status: 400, field: "payload.authorization.from",
      publicMessage: "Payment payer differs from the readiness quote", paymentMayHaveSettled: false,
    });
    expect(answer(new Error("ORDER_NOT_FOUND"))).toMatchObject({
      code: "CHALLENGE_EXPIRED", status: 409, paymentMayHaveSettled: false,
    });
  });

  it("explains an order that was no longer claimable from the order as read again", () => {
    const conflict = new Error("ORDER_ADMISSION_CONFLICT");
    const order = (paymentPayloadHash: string | null, state = "NOT_SETTLED") =>
      ({ orderId: "order-1", state, paymentPayloadHash }) as unknown as StandardOrderRecord;
    const mapped = (current: StandardOrderRecord | null | "unread") =>
      paymentAdmissionFailure(conflict, context(current)) as StandardRailError;
    expect(mapped(order(null))).toMatchObject({ code: "CHALLENGE_EXPIRED", paymentMayHaveSettled: false });
    expect(mapped(null)).toMatchObject({ code: "CHALLENGE_EXPIRED" });
    // Another authorization holds the order and may settle.
    expect(mapped(order(hash("b"), "ATTEMPT_OPENED"))).toMatchObject({
      code: "PAYMENT_IDENTIFIER_CONFLICT", paymentMayHaveSettled: true,
    });
    expect(mapped("unread")).toMatchObject({ code: "PAYMENT_PENDING_RECONCILIATION", paymentMayHaveSettled: true });
  });

  it("leaves the release fences and anything unrecognized to the existing mapping", () => {
    for (const error of [new Error("SALE_SUSPENDED"), new Error("CONTRACT_RETIRED"), new Error("unexpected"),
      Object.assign(new Error("duplicate key"), { code: "23505" })]) {
      expect(paymentAdmissionFailure(error, context())).toBe(error);
    }
  });
});

async function serve(h: ReturnType<typeof purchaseHarness>) {
  const app = express();
  app.use(express.json());
  app.use(createStandardRailRouter(h.service, "https://gateway.example"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return {
    url: `http://127.0.0.1:${address.port}/outcomes/7/outcome`,
    close: async () => {
      h.gate.resolve();
      await h.responses.drain();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function submit(url: string, format: "json" | "header", h: ReturnType<typeof purchaseHarness>) {
  return fetch(url + (format === "json" ? "/purchase" : ""), {
    method: "POST",
    headers: { "content-type": "application/json",
      ...(format === "header" ? { "payment-signature": Buffer.from(JSON.stringify(h.args.payment)).toString("base64url") } : {}) },
    body: JSON.stringify(format === "json" ? { request: h.args.body, paymentPayload: h.args.payment } : h.args.body),
  });
}

describe("purchase HTTP answers to a claim that did not commit", () => {
  it.each(["json", "header"] as const)("on the %s endpoint: 503 with Retry-After, then the identical resend is admitted", async (format) => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const h = purchaseHarness();
    const claimOnce = h.store.claimAuthorization.getMockImplementation()!;
    h.store.claimAuthorization.mockImplementationOnce(async () => { throw serialization(); });
    const http = await serve(h);
    try {
      const refused = await submit(http.url, format, h);
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("2");
      if (format === "json") {
        expect(refused.headers.get("daski-next-action")).toBe(
          "Wait for Retry-After, then resend the identical signed purchase; do not sign again. Nothing was claimed or settled.");
      }
      const body = await refused.json() as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({
        code: "PAYMENT_ADMISSION_UNAVAILABLE", phase: "payment_validation", retryable: true,
        requiresNewSignature: false, paymentMayHaveSettled: false,
      });
      expect(h.current().state).toBe("CHALLENGE_ISSUED");
      expect(h.facilitator.verify).not.toHaveBeenCalled();
      h.store.claimAuthorization.mockImplementation(claimOnce);
      const admitted = await submit(http.url, format, h);
      expect(admitted.status).toBe(202);
      expect(await admitted.json()).toMatchObject({ orderHandle: "handle-1", state: "ATTEMPT_OPENED" });
    } finally { await http.close(); }
    expect(h.facilitator.settle).toHaveBeenCalledOnce();
  });

  it("answers a capacity refusal 409 without Retry-After or a 500", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const h = purchaseHarness();
    h.store.claimAuthorization.mockImplementationOnce(async () => { throw new Error("OUTCOME_CAPACITY_EXHAUSTED"); });
    const http = await serve(h);
    try {
      const refused = await submit(http.url, "json", h);
      expect(refused.status).toBe(409);
      expect(refused.headers.get("retry-after")).toBeNull();
      expect((await refused.json() as { error: unknown }).error).toMatchObject({
        code: "OUTCOME_CAPACITY_EXHAUSTED", retryable: true, requiresNewSignature: false, paymentMayHaveSettled: false,
      });
    } finally { await http.close(); }
    expect(h.facilitator.verify).not.toHaveBeenCalled();
  });

  it("answers a lost duplicate race as a replay of the order its twin claimed", async () => {
    const h = purchaseHarness();
    const claimOnce = h.store.claimAuthorization.getMockImplementation()!;
    // The twin's claim commits first; this one then finds the order claimed.
    h.store.claimAuthorization.mockImplementationOnce(async (args) => {
      await claimOnce({ ...args, paymentPayloadHash: args.paymentPayloadHash });
      throw new Error("ORDER_ADMISSION_CONFLICT");
    });
    await expect(h.service.submitPayment(h.args)).resolves.toMatchObject({ handle: "handle-1", replay: true });
  });

  it("records the changed-authorization replay a concurrent claim of another order reveals", async () => {
    const h = purchaseHarness();
    const holder = { ...h.current(), orderId: "order-2", state: "ATTEMPT_OPENED" } as StandardOrderRecord;
    h.store.claimAuthorization.mockImplementationOnce(async () => { throw new Error("PAYMENT_AUTHORIZATION_ALREADY_CLAIMED"); });
    h.store.findByAuthorizationKey.mockResolvedValueOnce(null).mockResolvedValueOnce({ handle: "handle-2", order: holder } as never);
    const incidents = (h.service as unknown as { incidents: { record: ReturnType<typeof vi.fn> } }).incidents;
    await expect(h.service.submitPayment(h.args)).rejects.toMatchObject({
      code: "PAYMENT_IDENTIFIER_CONFLICT", paymentMayHaveSettled: true,
    });
    expect(incidents.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: "changed_payment_authorization_replay", orderId: "order-2",
    }));
  });

  it("serializes the new answers as standard error envelopes", () => {
    const envelope = standardRailPublicError(new StandardRailError("PAYMENT_ADMISSION_UNAVAILABLE"), "https://gateway.example");
    expect(envelope).toMatchObject({ code: "PAYMENT_ADMISSION_UNAVAILABLE", docs: "https://gateway.example/skills/buy.md#errors" });
  });
});
