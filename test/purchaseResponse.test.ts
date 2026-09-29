import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { PURCHASE_RESPONSE_WAIT_MS } from "../src/standardRail/purchaseResponse.js";
import { logger } from "../src/util/logger.js";
import { validatePayment } from "../src/standardRail/payment.js";
import { deferred, hash, payer, purchaseHarness, type Stage } from "./helpers/purchaseResponseFixture.js";

// Keep the real submit, replay, settlement and lease orchestration. Crypto and
// external systems have separate contract tests; no live payment is made here.
vi.mock("../src/standardRail/payment.js", async (original) => ({
  ...await original<typeof import("../src/standardRail/payment.js")>(),
  validatePayment: vi.fn(async () => ({ payer, nonce: hash("3"), authorizationKey: hash("9") })),
}));
vi.mock("../src/standardRail/reputationEligibility.js", () => ({ isReputationEligiblePayer: () => true }));
vi.mock("../src/standardRail/reputationOrders.js", () => ({ buildReputationRegistration: async () => ({}) }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded admitted purchase response", () => {
  it.each<Stage>(["settlement", "deposit", "release", "dispatch"])(
    "returns pending while %s is delayed, retains the driver and deduplicates replays", async (stage) => {
      vi.useFakeTimers();
      const h = purchaseHarness(stage);
      const pending = h.service.submitPayment(h.args);
      await h.entered.promise;
      await vi.advanceTimersByTimeAsync(PURCHASE_RESPONSE_WAIT_MS);
      await expect(pending).resolves.toMatchObject({
        handle: "handle-1", order: { state: "ATTEMPT_OPENED" }, replay: false,
      });
      expect(h.held()).toBe(true);
      expect(h.store.releaseLease).not.toHaveBeenCalled();
      // Receipt generation for the admission snapshot must not wait on DB/RPC.
      const reply = await pending;
      await expect(h.service.purchaseReceipts(reply.order)).resolves.toEqual({
        receipt: null, x402OfferReceipt: null, x402PaymentResponse: null,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.store.renewLease).toHaveBeenCalledTimes(4);
      expect(await h.store.leaseOrder()).toBeNull(); // recovery cannot take over
      const replays = await Promise.all([h.service.submitPayment(h.args), h.service.submitPayment(h.args)]);
      expect(replays.every((r) => r.handle === "handle-1" && r.replay)).toBe(true);
      await expect(h.service.submitPayment({ ...h.args, body: { sku: "changed" } }))
        .rejects.toMatchObject({ code: "PAYMENT_IDENTIFIER_CONFLICT" });
      await expect(h.service.submitPayment({ ...h.args, payment: { ...h.args.payment, payload: {} } }))
        .rejects.toMatchObject({ code: "PAYMENT_IDENTIFIER_CONFLICT" });
      h.gate.resolve();
      await h.responses.drain();
      expect(h.current().state).toBe("DISPATCHED");
      expect(h.facilitator.settle).toHaveBeenCalledOnce();
      expect(h.journal.markSettleInvoked).toHaveBeenCalledOnce();
      expect(h.dispatch).toHaveBeenCalledOnce();
      expect(h.store.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it("races initial submissions without starting another settlement driver", async () => {
    vi.useFakeTimers();
    const h = purchaseHarness();
    const first = h.service.submitPayment(h.args);
    const second = h.service.submitPayment(h.args);
    await h.entered.promise;
    await vi.advanceTimersByTimeAsync(PURCHASE_RESPONSE_WAIT_MS);
    const replies = await Promise.all([first, second]);
    expect(replies.map((reply) => reply.handle)).toEqual(["handle-1", "handle-1"]);
    expect(replies.filter((reply) => reply.replay)).toHaveLength(1);
    h.gate.resolve();
    await h.responses.drain();
    expect(h.facilitator.settle).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("preserves the immediate success path and clears its response timer", async () => {
    vi.useFakeTimers();
    const h = purchaseHarness();
    h.gate.resolve();
    await expect(h.service.submitPayment(h.args)).resolves.toMatchObject({ order: { state: "DISPATCHED" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects failed admission without scheduling payment work", async () => {
    const h = purchaseHarness();
    vi.mocked(validatePayment).mockRejectedValueOnce(new Error("invalid signature"));
    await expect(h.service.submitPayment(h.args)).rejects.toThrow("invalid signature");
    expect(h.store.claimAuthorization).not.toHaveBeenCalled();
    expect(h.facilitator.settle).not.toHaveBeenCalled();
  });

  it("preserves an early facilitator refusal and its no-settlement semantics", async () => {
    const h = purchaseHarness();
    h.facilitator.verify.mockResolvedValueOnce({ isValid: false, payer });
    await expect(h.service.submitPayment(h.args)).rejects.toMatchObject({ code: "FACILITATOR_REJECTED" });
    expect(h.current().state).toBe("VERIFY_REJECTED");
    expect(h.facilitator.settle).not.toHaveBeenCalled();
    expect(h.store.releaseLease).toHaveBeenCalledOnce();
  });

  it("handles a late failure without logging payloads and leaves journaled ambiguity for recovery", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const h = purchaseHarness();
    const pending = h.service.submitPayment(h.args);
    await h.entered.promise;
    await vi.advanceTimersByTimeAsync(PURCHASE_RESPONSE_WAIT_MS);
    await pending;
    h.gate.reject(new Error("secret supplier response"));
    await h.responses.drain();
    expect(h.current().state).toBe("SETTLEMENT_AMBIGUOUS");
    expect(h.held()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      orderId: "order-1", code: "PAYMENT_PENDING_RECONCILIATION",
    });
    await h.service.submitPayment(h.args);
    expect(h.facilitator.settle).toHaveBeenCalledOnce();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("drains a disconnected admission and the driver it starts during shutdown", async () => {
    vi.useFakeTimers();
    const h = purchaseHarness();
    const admission = deferred();
    Object.assign(h.service, { assertRailFence: () => admission.promise });
    const purchase = h.service.submitPayment(h.args);
    let stopped = false;
    const stopping = h.service.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    admission.resolve();
    await h.entered.promise;
    await vi.advanceTimersByTimeAsync(PURCHASE_RESPONSE_WAIT_MS);
    await purchase;
    expect(stopped).toBe(false);
    h.gate.resolve();
    await stopping;
    expect(h.current().state).toBe("DISPATCHED");
  });

  it("drains the detached driver during service shutdown", async () => {
    vi.useFakeTimers();
    const h = purchaseHarness();
    const pending = h.service.submitPayment(h.args);
    await h.entered.promise;
    await vi.advanceTimersByTimeAsync(PURCHASE_RESPONSE_WAIT_MS);
    await pending;
    let stopped = false;
    const stopping = h.service.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(stopped).toBe(false);
    expect(h.held()).toBe(true);
    h.gate.resolve();
    await stopping;
    expect(h.current().state).toBe("DISPATCHED");
    expect(h.held()).toBe(false);
  });
});

async function serve(h: ReturnType<typeof purchaseHarness>) {
  const app = express();
  app.use(express.json());
  app.use(createStandardRailRouter(h.service));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}/outcomes/7/outcome`;
  return { server, url, close: async () => {
    h.gate.resolve();
    await h.responses.drain();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

describe("purchase HTTP lifecycle", () => {
  it.each(["json", "header"])("returns 202 on the %s endpoint while settlement is pending", async (format) => {
    const h = purchaseHarness();
    const http = await serve(h);
    try {
      const response = await fetch(http.url + (format === "json" ? "/purchase" : ""), {
        method: "POST", headers: { "content-type": "application/json",
          ...(format === "header" ? { "payment-signature": Buffer.from(JSON.stringify(h.args.payment)).toString("base64url") } : {}) },
        body: JSON.stringify(format === "json" ? { request: h.args.body, paymentPayload: h.args.payment } : h.args.body),
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("payment-response")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        orderHandle: "handle-1", state: "ATTEMPT_OPENED", receipt: null, x402OfferReceipt: null,
      });
      expect(h.held()).toBe(true);
      expect(h.dispatch).not.toHaveBeenCalled();
    } finally { await http.close(); }
    expect(h.facilitator.settle).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("continues after forced disconnection and reconciles the same authorization", async () => {
    const h = purchaseHarness("dispatch");
    vi.spyOn(h.service, "purchaseReceipts").mockResolvedValue({ receipt: null, x402OfferReceipt: null, x402PaymentResponse: null });
    const http = await serve(h);
    try {
      const req = httpRequest(http.url + "/purchase", { method: "POST", headers: { "content-type": "application/json" } });
      req.on("error", () => undefined);
      req.end(JSON.stringify({ request: h.args.body, paymentPayload: h.args.payment }));
      await h.entered.promise;
      const closed = once(req, "close").catch(() => undefined);
      req.destroy();
      await closed;
      const replay = await h.service.submitPayment(h.args);
      expect(replay).toMatchObject({ handle: "handle-1", replay: true, order: { state: "DISPATCH_STARTED" } });
      h.gate.resolve();
      await h.responses.drain();
      expect(h.current().state).toBe("DISPATCHED");
      expect(h.facilitator.settle).toHaveBeenCalledOnce();
      expect(h.dispatch).toHaveBeenCalledOnce();
    } finally { await http.close(); }
  });
});
