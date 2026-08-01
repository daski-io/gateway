import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPurchaseRouter, type PurchaseDeps } from "../src/payment/routes.js";

// The readiness gate is the FIRST check in handleInitialPurchase, before
// any other dependency is touched, so stub deps beyond the probe are never
// reached. This pins the 2026-08-01 fix: a fail-closed refusal of a paid
// POST must carry its reason (e.g. rpc_unavailable) instead of being a
// bare, silent 503 — the e2e runner's INFRA classifier matches on it.
describe("purchase readiness refusal", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("returns 503 with the probe's failedCheck when the deployment is not ready", async () => {
    const deps = {
      deploymentReadiness: {
        isReady: async () => false,
        status: () => ({ ready: false, failedCheck: "rpc_unavailable" }),
      },
    } as unknown as PurchaseDeps;

    const app = express();
    app.use(express.json());
    app.use(createPurchaseRouter(deps));
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/purchase/2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerTokenId: "5" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("rpc_unavailable");
    expect(body.retryable).toBe(true);
    expect(body.error).toBe(
      "Payment cannot be processed right now. Please try again later.",
    );
  });
});
