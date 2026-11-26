import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { issueReadCapability } from "../src/standardRail/readCapability.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { artifactWithoutProviderTask, StandardRailService } from "../src/standardRail/service.js";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import type { StandardOrderRecord, StandardOrderState } from "../src/standardRail/types.js";

const DELIVERING = "The order is paid and still being delivered; it has no artifact yet";
const PLAIN = "The order has no artifact: it is neither completed nor recovered";

// What an artifact read answers for an order without a provider task, in every
// state: "delivering" and "plain" are ARTIFACT_NOT_AVAILABLE with deliveryState
// delivering and not_delivering. A new state fails the typecheck here until it
// is classified.
const ANSWER: Record<StandardOrderState, "delivering" | "plain" | "internal"> = {
  DRAFT: "plain",
  CHALLENGE_ISSUED: "plain",
  ATTEMPT_OPENED: "plain",
  VERIFIED: "plain",
  VERIFY_REJECTED: "plain",
  SETTLE_INVOKED: "plain",
  FACILITATOR_CONFIRMED: "delivering",
  SETTLEMENT_AMBIGUOUS: "plain",
  SETTLEMENT_FAILED: "plain",
  EXTERNAL_OR_UNPROVEN_DEPOSIT: "plain",
  DEPOSIT_FINAL: "delivering",
  RELEASE_FINAL: "delivering",
  DISPATCH_STARTED: "delivering",
  DISPATCH_AMBIGUOUS: "delivering",
  PROVIDER_FAILED: "plain",
  LEGAL_HOLD: "plain",
  NOT_SETTLED: "plain",
  // Only an order with a provider task reaches these; one without is the
  // gateway's own inconsistency.
  DISPATCHED: "internal",
  INPUT_REQUIRED: "internal",
  FULFILLED: "internal",
};

// A buyer reads the artifact right after paying, while the gateway is still
// dispatching the order and the provider has no task for it yet. There is
// nothing to read: the answer is ARTIFACT_NOT_AVAILABLE, never the
// INTERNAL_ERROR that told agents to stop and report a paid order that was
// still being delivered.
describe("an artifact read before the provider has the order", () => {
  const signer = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const key = Buffer.alloc(32, 7);
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function read(action: "status" | "artifact", state: StandardOrderState, capabilityEpoch = 0) {
    const order = {
      orderId: "ord", providerTaskId: null, state, orderKey: `0x${"ab".repeat(32)}`,
      payer: signer.address, capabilityEpoch: 0,
    } as unknown as StandardOrderRecord;
    const providerFetch = vi.fn(async () => { throw new Error("the provider has no task to ask"); });
    const service = Object.assign(Object.create(StandardRailService.prototype), {
      assertRailFence: async () => undefined,
      store: { findByHandle: async () => order },
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: { encryptionKey: key, gatewayAudience: "gateway.example", environment: "testnet",
        signers: localGatewaySigners(`0x${"34".repeat(32)}`), dispatchTimeoutMs: 3_000 },
      receiptOrPending: async () => null,
      confirmationState: { stored: async () => null },
      providerFetch,
    }) as StandardRailService;
    const app = express(); app.use(express.json());
    app.use(createStandardRailRouter(service, "https://gateway.example"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const { readCapability } = issueReadCapability({
      key, orderId: "ord", payer: signer.address, audience: "gateway.example", capabilityEpoch, ttlSeconds: 60,
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/orders/handle/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `DaskiReadCap ${readCapability}` },
      body: JSON.stringify({ request: {} }),
    });
    expect(providerFetch).not.toHaveBeenCalled();
    return { response, body: await response.json() as Record<string, unknown> & { error: Record<string, unknown> } };
  }

  it("answers 409 ARTIFACT_NOT_AVAILABLE for a paid order still being dispatched", async () => {
    const { response, body } = await read("artifact", "DISPATCH_STARTED");

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("daski-next-action")).toMatch(/^Read the order status again/);
    expect(body.error).toMatchObject({
      code: "ARTIFACT_NOT_AVAILABLE", phase: "dispatch", retryable: true, requiresNewSignature: false,
      paymentMayHaveSettled: false, message: DELIVERING, deliveryState: "delivering",
    });
  });

  it("still serves the gateway's own status for the same order", async () => {
    const { response, body } = await read("status", "DISPATCH_STARTED");

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ orderHandle: "handle", state: "DISPATCH_STARTED" });
  });

  it("names no delivery for an order that never reached its provider", async () => {
    const { response, body } = await read("artifact", "NOT_SETTLED");

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "ARTIFACT_NOT_AVAILABLE", message: PLAIN, deliveryState: "not_delivering" });
  });

  it("says nothing about the order to a read the gateway does not authorize", async () => {
    const { response, body } = await read("artifact", "DISPATCH_STARTED", 1);

    expect(response.status).toBe(401);
    expect(body.error).toMatchObject({ code: "WALLET_AUTHORIZATION_INVALID" });
    expect(JSON.stringify(body)).not.toContain("deliver");
  });

  it.each(Object.entries(ANSWER) as Array<[StandardOrderState, "delivering" | "plain" | "internal"]>)(
    "answers a %s order without a provider task as %s", (state, answer) => {
      const error = artifactWithoutProviderTask(state);
      if (answer === "internal") {
        expect(error).toMatchObject({ code: "INTERNAL_ERROR", status: 500, message: "PROVIDER_TASK_NOT_AVAILABLE" });
        expect(error.deliveryState).toBeUndefined();
      } else {
        expect(error).toMatchObject({
          code: "ARTIFACT_NOT_AVAILABLE", status: 409, retryable: true,
          publicMessage: answer === "delivering" ? DELIVERING : PLAIN,
          deliveryState: answer === "delivering" ? "delivering" : "not_delivering",
        });
      }
    });
});
