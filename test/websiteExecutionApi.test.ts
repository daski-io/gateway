import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { standardRailError } from "../src/standardRail/errors.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});
async function start(service: Record<string, unknown>) {
  const app = express(); app.use(express.json());
  app.use(createStandardRailRouter(service as never, "https://gateway.example"));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, body: unknown) => fetch(root + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const payer = "0x" + "1".repeat(40);

describe("website MCP execution API", () => {
  it("keeps quote creation and signed submission in the existing service without mutating provider input", async () => {
    const issueChallenge = vi.fn(async () => ({ paymentRequired: { x402Version: 2, accepts: [] } }));
    const preparePaymentChallenge = vi.fn(async () => ({ orderHandle: "draft", paymentRequired: { x402Version: 2 }, preflight: { sufficient: false } }));
    const submitPayment = vi.fn(async () => ({ handle: "paid", order: { state: "DISPATCHED" } }));
    const post = await start({ issueChallenge, preparePaymentChallenge, submitPayment,
      purchaseReceipts: async () => ({ receipt: { paid: true }, x402OfferReceipt: null, x402PaymentResponse: { success: true } }) });
    const request = { name: "example.info", payerAddress: "provider-data-not-the-payer" };
    const quote = await post("/outcomes/42/domain/quote", { request, payerAddress: payer });
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({ orderHandle: "draft", preflight: { sufficient: false } });
    expect(preparePaymentChallenge).toHaveBeenCalledWith({ providerAgentId: "42", outcomeId: "domain", body: request, payerAddress: payer });
    const unpaid = await post("/outcomes/42/domain/purchase", { request, payerAddress: payer });
    expect(unpaid.status).toBe(402);
    expect(submitPayment).not.toHaveBeenCalled();
    const payment = { x402Version: 2, payload: { signature: "0xsignature" }, extensions: { large: "x".repeat(20_000) } };
    const paid = await post("/outcomes/42/domain/purchase", { request, payerAddress: payer, paymentPayload: payment });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(Buffer.from(paid.headers.get("payment-response")!, "base64url").toString())).toEqual({ success: true });
    expect(submitPayment).toHaveBeenCalledExactlyOnceWith({ providerAgentId: "42", outcomeId: "domain", body: request, payerAddress: payer, payment });
    expect(await paid.json()).toEqual({ orderHandle: "paid", state: "DISPATCHED", receipt: { paid: true }, x402OfferReceipt: null });
  });

  it("validates every new anonymous input before invoking transaction services", async () => {
    const preparePaymentChallenge = vi.fn(); const submitPayment = vi.fn(); const issueChallenge = vi.fn(); const searchOutcomes = vi.fn();
    const post = await start({ preparePaymentChallenge, submitPayment, issueChallenge, searchOutcomes });
    for (const [path, body] of [
      ["/outcomes/42/domain/purchase", { request: {}, extra: "invalid" }],
      ["/outcomes/42/domain/purchase", { request: [], paymentPayload: {} }],
      ["/outcomes/42/domain/quote", { request: {}, paymentPayload: {} }],
      ["/outcomes/42/domain/quote", { request: {}, payerAddress: "not-an-address" }],
      ["/public/v2/outcomes/search", { limit: 101 }],
      ["/public/v2/outcomes/search", { persistentAsset: "true" }],
    ] as const) expect((await post(path, body)).status).toBe(400);
    for (const method of [preparePaymentChallenge, submitPayment, issueChallenge, searchOutcomes]) expect(method).not.toHaveBeenCalled();
  });

  it("preserves payment reconciliation in the wallet challenge and authorized read", async () => {
    const issueWalletChallenge = vi.fn(async (_args: unknown) => ({ signRequest: {} }));
    const listWalletOrders = vi.fn(async () => ({ orders: [] }));
    const post = await start({ issueWalletChallenge, listWalletOrders });
    const input = { payer, cursor: null, limit: 25, paymentIdentifier: "intent-123456789012" };
    expect((await post("/wallet/orders", { ...input, authorization: null })).status).toBe(200);
    expect(issueWalletChallenge.mock.calls[0]?.[0]).toMatchObject({ request: { limit: 25, cursor: null, paymentIdentifier: input.paymentIdentifier }, absoluteResourceUri: "https://gateway.example/wallet/orders" });
    const authorization = { signature: "proof" };
    expect((await post("/wallet/orders", { ...input, authorization })).status).toBe(200);
    expect(listWalletOrders).toHaveBeenCalledWith({ ...input, authorization });
    expect((await post("/wallet/orders", { ...input, paymentIdentifier: "bad", authorization: null })).status).toBe(400);
  });

  it("returns gateway signature refusals and recovery guidance without executing a purchase", async () => {
    const submitPayment = vi.fn(async () => { throw standardRailError("SIGNATURE_INVALID"); });
    const purchaseReceipts = vi.fn();
    const post = await start({ submitPayment, purchaseReceipts });
    const response = await post("/outcomes/42/domain/purchase", { request: {}, paymentPayload: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "SIGNATURE_INVALID", paymentMayHaveSettled: false } });
    expect(response.headers.get("daski-next-action")).toBeTruthy();
    expect(purchaseReceipts).not.toHaveBeenCalled();
  });
});
