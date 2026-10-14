import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { standardRailPublicError } from "../src/standardRail/errors.js";
import { LIFECYCLE_RETRY_AFTER_SECONDS, providerLifecycleRefusal } from "../src/standardRail/lifecycleRefusal.js";
import { issueReadCapability } from "../src/standardRail/readCapability.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { StandardRailService } from "../src/standardRail/service.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";

const refusal = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" } });
const raw = (status: number, text: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Response(text, { status, headers });

const LIFECYCLE_ACTIONS = ["status", "input", "cancel", "artifact", "support"] as const;

describe("provider lifecycle refusals", () => {
  it("names an unfinished artifact read to the buyer", async () => {
    const error = await providerLifecycleRefusal("artifact", refusal(409, { error: "artifact_unavailable" }));
    expect(error).toMatchObject({ code: "ARTIFACT_NOT_AVAILABLE", status: 409, retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: false });
  });

  it.each([
    ["artifact", 409, { error: "artifact_unavailable", detail: "extra" }],
    ["artifact", 409, { error: "lifecycle_rejected" }],
    ["artifact", 401, { error: "artifact_unavailable" }],
    ["status", 409, { error: "artifact_unavailable" }],
  ])("keeps a %s refusal with status %s and an unexpected body internal", async (action, status, body) => {
    expect(await providerLifecycleRefusal(action, refusal(status, body))).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("keeps an unreadable refusal internal", async () => {
    const response = new Response("not json", { status: 409, headers: { "content-type": "text/plain" } });
    expect(await providerLifecycleRefusal("artifact", response)).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  describe.each(LIFECYCLE_ACTIONS)("on %s", (action) => {
    it("names an unsupported action, which changed nothing and is not retried", async () => {
      expect(await providerLifecycleRefusal(action, refusal(409, { error: "unsupported_action" }))).toMatchObject({
        code: "ORDER_ACTION_UNSUPPORTED", status: 409, phase: "dispatch", retryable: false,
        requiresNewSignature: false, paymentMayHaveSettled: false,
        publicMessage: "The provider does not support this action for this order; nothing was changed",
      });
    });

    it("names an action identity already bound to different content", async () => {
      expect(await providerLifecycleRefusal(action, refusal(409, { error: "action_conflict" }))).toMatchObject({
        code: "ORDER_ACTION_CONFLICT", status: 409, phase: "dispatch", retryable: false,
        requiresNewSignature: false, paymentMayHaveSettled: false,
      });
    });

    it("names a temporarily unavailable provider without claiming nothing happened", async () => {
      const signed = await providerLifecycleRefusal(action, refusal(503, { error: "lifecycle_unavailable" }));
      expect(signed).toMatchObject({ code: "PROVIDER_LIFECYCLE_UNAVAILABLE", status: 503, phase: "dispatch",
        retryable: true, requiresNewSignature: true, paymentMayHaveSettled: false });
      expect(signed.publicMessage).toContain("may still have taken effect");
      expect(signed.nextAction).toMatch(/at most three times/);
      expect(signed.nextAction).toMatch(/fresh order action authorization/);
      expect(signed.nextAction).toMatch(/requestId/);
      // A read capability carries no nonce: the same capability retries the read.
      const read = await providerLifecycleRefusal(action, refusal(503, { error: "lifecycle_unavailable" }), {
        readCapability: true });
      expect(read).toMatchObject({ code: "PROVIDER_LIFECYCLE_UNAVAILABLE", retryable: true, requiresNewSignature: false });
    });
  });

  it.each([
    ["unsupported_action at another status", 400, { error: "unsupported_action" }],
    ["unsupported_action at 404", 404, { error: "unsupported_action" }],
    ["unsupported_action at 503", 503, { error: "unsupported_action" }],
    ["action_conflict at 412", 412, { error: "action_conflict" }],
    ["action_conflict at 503", 503, { error: "action_conflict" }],
    ["lifecycle_unavailable at 409", 409, { error: "lifecycle_unavailable" }],
    ["lifecycle_unavailable at 500", 500, { error: "lifecycle_unavailable" }],
    ["lifecycle_unavailable at 502", 502, { error: "lifecycle_unavailable" }],
    ["lifecycle_unavailable at 429", 429, { error: "lifecycle_unavailable" }],
    ["artifact_unavailable at 503", 503, { error: "artifact_unavailable" }],
    ["an extra key", 409, { error: "unsupported_action", detail: "supplier says no" }],
    ["an extra key on unavailability", 503, { error: "lifecycle_unavailable", retryAfter: 1 }],
    ["an unknown code", 409, { error: "not_supported" }],
    ["another spelling", 409, { error: "UNSUPPORTED_ACTION" }],
    ["padding inside the code", 503, { error: " lifecycle_unavailable" }],
    ["a structured code", 409, { error: { code: "action_conflict" } }],
    ["a code list", 409, { error: ["unsupported_action"] }],
    ["a null code", 503, { error: null }],
    ["a renamed key", 409, { code: "unsupported_action" }],
    ["an empty object", 503, {}],
    ["a bare string", 409, "unsupported_action"],
    ["an array", 503, [{ error: "lifecycle_unavailable" }]],
  ])("keeps %s internal on every lifecycle action", async (_name, status, body) => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(await providerLifecycleRefusal(action, refusal(status, body))).toMatchObject({ code: "INTERNAL_ERROR" });
    }
  });

  it.each([
    ["an oversized body", () => raw(503, `{"error":"lifecycle_unavailable"${" ".repeat(1_024)}}`)],
    ["a declared oversized length", () => raw(409, JSON.stringify({ error: "unsupported_action" }),
      { "content-type": "application/json", "content-length": "1025" })],
    ["a text body", () => raw(409, JSON.stringify({ error: "unsupported_action" }), { "content-type": "text/plain" })],
    ["an edge page", () => raw(503, "<html><body>503 Service Temporarily Unavailable</body></html>",
      { "content-type": "text/html" })],
    ["no media type", () => new Response(JSON.stringify({ error: "lifecycle_unavailable" }), { status: 503,
      headers: { "content-type": "" } })],
    ["a compressed body", () => raw(503, JSON.stringify({ error: "lifecycle_unavailable" }),
      { "content-type": "application/json", "content-encoding": "gzip" })],
    ["a duplicate key", () => raw(409, '{"error":"not_this","error":"action_conflict"}')],
    ["malformed JSON", () => raw(409, '{"error":"unsupported_action"')],
    ["an empty body", () => new Response(null, { status: 503, headers: { "content-type": "application/json" } })],
  ])("keeps %s internal", async (_name, response) => {
    for (const action of LIFECYCLE_ACTIONS) {
      expect(await providerLifecycleRefusal(action, response())).toMatchObject({ code: "INTERNAL_ERROR" });
    }
  });

  it("puts nothing the provider wrote into the buyer's answer", async () => {
    const error = await providerLifecycleRefusal("support", refusal(409, { error: "action_conflict" }));
    const body = standardRailPublicError(error, "https://gateway.example");
    expect(Object.keys(body).sort()).toEqual([
      "code", "correlationId", "docs", "message", "paymentMayHaveSettled", "phase", "requiresNewSignature", "retryable",
    ]);
    expect(JSON.stringify(body)).not.toContain("action_conflict");
  });
});

describe("provider lifecycle refusals at the buyer surface", () => {
  const signer = privateKeyToAccount(`0x${"12".repeat(32)}`);
  const key = Buffer.alloc(32, 7);
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  });

  async function read(action: "status" | "artifact", answer: () => Response) {
    const order = {
      orderId: "ord", providerTaskId: "task", state: "DISPATCHED", payer: signer.address, capabilityEpoch: 0,
      listing: { providerControlProfile: { payload: {
        providerAudience: "provider.example", lifecycleUrl: "https://provider.example/standard-rail/lifecycle",
        timeoutMs: 3_000, maxResponseBytes: 65_536,
      } } },
    } as unknown as StandardOrderRecord;
    const providerFetch = vi.fn(async () => answer());
    const service = Object.assign(Object.create(StandardRailService.prototype), {
      assertRailFence: async () => undefined,
      store: { findByHandle: async () => order },
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: { encryptionKey: key, gatewayAudience: "gateway.example", environment: "testnet",
        lifecyclePrivateKey: `0x${"34".repeat(32)}`, dispatchTimeoutMs: 3_000 },
      providerFetch,
    }) as StandardRailService;
    const app = express(); app.use(express.json());
    app.use(createStandardRailRouter(service, "https://gateway.example"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const { readCapability } = issueReadCapability({
      key, orderId: "ord", payer: signer.address, audience: "gateway.example", capabilityEpoch: 0, ttlSeconds: 60,
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/orders/handle/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `DaskiReadCap ${readCapability}` },
      body: JSON.stringify({ request: {} }),
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    return { response, body: await response.json() as { error: Record<string, unknown> } };
  }

  it("answers a provider that cannot serve the read yet with 503 and a bounded Retry-After", async () => {
    const { response, body } = await read("status", () => refusal(503, { error: "lifecycle_unavailable" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe(String(LIFECYCLE_RETRY_AFTER_SECONDS));
    expect(response.headers.get("daski-next-action")).toMatch(/at most three times/);
    expect(body.error).toMatchObject({ code: "PROVIDER_LIFECYCLE_UNAVAILABLE", retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: false });
  });

  it("answers an unsupported action with 409 and no retry", async () => {
    const { response, body } = await read("artifact", () => refusal(409, { error: "unsupported_action" }));
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(body.error).toMatchObject({ code: "ORDER_ACTION_UNSUPPORTED", retryable: false });
  });

  it("keeps the artifact refusal contract", async () => {
    const { response, body } = await read("artifact", () => refusal(409, { error: "artifact_unavailable" }));
    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "ARTIFACT_NOT_AVAILABLE", retryable: true, requiresNewSignature: false });
  });

  it.each([
    ["an edge page", () => raw(503, "<html>upstream error</html>", { "content-type": "text/html" })],
    ["a refusal with supplier text", () => refusal(503, { error: "lifecycle_unavailable", message: "supplier detail" })],
  ])("answers %s as an internal error that names nothing", async (_name, answer) => {
    const { response, body } = await read("status", answer);
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(body.error).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    expect(JSON.stringify(body)).not.toContain("supplier detail");
  });
});
