import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { ORDER_STATUS_VIEW_HEADER, PROVIDER_LIFECYCLE_HEADERS } from "../src/standardRail/orderStatusView.js";
import { issueReadCapability } from "../src/standardRail/readCapability.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { assertTransition } from "../src/standardRail/stateMachine.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";

// The provider adds the buyer's input request and the order's documents to a
// payer-authorized status read. The gateway passes them through to the buyer
// after validating them, and never hands them to persistence.
const signer = privateKeyToAccount(`0x${"12".repeat(32)}`);
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;

const INPUT_REQUEST = {
  schemaVersion: 1, requestedAt: 1_791_481_157, cause: "supplier_attention",
  summary: "Northwest, our filing agent, could not complete this filing.", reason: null,
  fields: [
    { path: "formData.responsible_party.last_name", label: "Responsible Party: Last Name", value: "personally", status: "as_submitted", editable: true },
    { path: "formData.ssn", label: "Social Security Number", value: null, status: "withheld", editable: true },
  ],
};
const DOCUMENTS = [{ documentId: "8d42e3f9-1111-4222-8333-944455556666", title: "Rejection Notice", type: "Rejection Notice", receivedAt: 1 }];

type Apply = (order: StandardOrderRecord, listing: StandardListing, response: unknown, action: string, handle: string) => Promise<Record<string, unknown>>;

function harness(orderState: StandardOrderRecord["state"] = "INPUT_REQUIRED") {
  const persistOperations = vi.fn(async () => undefined);
  const transition = vi.fn(async (order: StandardOrderRecord, to: StandardOrderRecord["state"]) => ({ ...order, state: to }));
  const service = Object.assign(Object.create(StandardRailService.prototype), {
    releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    store: { persistOperations, transition }, validateResponse: vi.fn(async () => undefined), signedReceipt: async () => null,
    confirmationState: { stored: async () => null }, submissionStatus: async () => null,
  }) as { applyLifecycleResult: Apply };
  const order = { orderId: "ord", providerTaskId: "task", state: orderState, orderKey: hash("1") } as StandardOrderRecord;
  const listing = { commitment: { payload: { providerAuthorityKey: signer.address, providerTerminalAttestationKey: signer.address } } } as StandardListing;
  return { service, order, listing, persistOperations, transition };
}

async function signed(state: string, additions: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { orderId: "ord", taskId: "task", state,
    operations: { schemaVersion: 1, revision: 1, observedAt: now, fulfillment: null, support: null, recovery: null },
    ...additions };
  return { payload, response: { ...payload, signature: await signer.signMessage({ message: { raw: canonicalHash(payload) } }) } };
}

describe("order status additions", () => {
  it("passes the input request and documents through on a status read without storing them", async () => {
    const { service, order, listing, persistOperations } = harness();
    const { payload, response } = await signed("input-required", { inputRequest: INPUT_REQUEST, documents: DOCUMENTS });

    const body = await service.applyLifecycleResult(order, listing, response, "status", "handle");

    expect(body).toMatchObject({ inputRequest: INPUT_REQUEST, documents: DOCUMENTS, orderState: "INPUT_REQUIRED" });
    expect(persistOperations).toHaveBeenCalledExactlyOnceWith("ord", payload.operations, null);
  });

  it("answers an order input that needs more input with the new request", async () => {
    const { service, order, listing } = harness();
    const { response } = await signed("input-required", { inputRequest: INPUT_REQUEST });

    await expect(service.applyLifecycleResult(order, listing, response, "input", "handle"))
      .resolves.toMatchObject({ inputRequest: INPUT_REQUEST });
  });

  it("carries documents in any state", async () => {
    const { service, order, listing } = harness("DISPATCHED");
    const { response } = await signed("working", { documents: DOCUMENTS });

    await expect(service.applyLifecycleResult(order, listing, response, "status", "handle"))
      .resolves.toMatchObject({ documents: DOCUMENTS });
  });

  it.each([
    ["an input request on an order not waiting for input", "working", { inputRequest: INPUT_REQUEST }, "status"],
    ["additions on a cancellation", "input-required", { documents: DOCUMENTS }, "cancel"],
    ["additions on a support answer", "input-required", { inputRequest: INPUT_REQUEST }, "support"],
  ])("refuses %s", async (_name, state, additions, action) => {
    const { service, order, listing, persistOperations } = harness();
    const { response } = await signed(state, additions);

    await expect(service.applyLifecycleResult(order, listing, response, action, "handle"))
      .rejects.toThrow("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
    expect(persistOperations).not.toHaveBeenCalled();
  });

  it.each([
    ["a control character", { ...INPUT_REQUEST, summary: "line one\nline two" }],
    ["an unknown field status", { ...INPUT_REQUEST, fields: [{ ...INPUT_REQUEST.fields[0], status: "guessed" }] }],
    ["an extra key", { ...INPUT_REQUEST, note: "free text" }],
  ])("refuses an input request with %s without echoing its values", async (_name, inputRequest) => {
    const { service, order, listing } = harness();
    const { response } = await signed("input-required", { inputRequest });

    const error = await service.applyLifecycleResult(order, listing, response, "status", "handle").catch((caught: unknown) => caught);

    expect(String((error as Error).message)).toContain("PROVIDER_ORDER_STATUS_VIEW_INVALID");
    expect(JSON.stringify(error)).not.toContain("personally");
  });

  it("still verifies the provider signature over the additions", async () => {
    const { service, order, listing } = harness();
    const { response } = await signed("input-required", { inputRequest: INPUT_REQUEST });

    await expect(service.applyLifecycleResult(order, listing, { ...response, documents: DOCUMENTS }, "status", "handle"))
      .rejects.toThrow("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
  });

  it("asks the provider for them on its lifecycle POST", async () => {
    // A provider adds them only when asked: a gateway released before them
    // refuses any response key it does not know.
    const key = Buffer.alloc(32, 7);
    const providerFetch = vi.fn(async (_listing: unknown, _url: string, _init: RequestInit) => {
      throw new Error("lifecycle POST captured");
    });
    const order = {
      orderId: "ord", providerTaskId: "task", state: "INPUT_REQUIRED", payer: signer.address, capabilityEpoch: 0,
      listing: { providerControlProfile: { payload: {
        providerAudience: "provider.example", lifecycleUrl: "https://provider.example/standard-rail/lifecycle",
        timeoutMs: 3_000, maxResponseBytes: 65_536,
      } } },
    } as unknown as StandardOrderRecord;
    const service = Object.assign(Object.create(StandardRailService.prototype), {
      assertRailFence: async () => undefined,
      store: { findByHandle: async () => order },
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: { encryptionKey: key, gatewayAudience: "gateway.example", environment: "testnet",
        lifecyclePrivateKey: `0x${"34".repeat(32)}`, dispatchTimeoutMs: 3_000 },
      providerFetch,
    }) as StandardRailService;
    const { readCapability } = issueReadCapability({
      key, orderId: "ord", payer: signer.address, audience: "gateway.example", capabilityEpoch: 0, ttlSeconds: 60,
    });

    await expect(service.performAction({ handle: "handle", action: "status", request: {}, readCapability }))
      .rejects.toThrow("lifecycle POST captured");

    const headers = providerFetch.mock.calls[0]![2].headers as Record<string, string>;
    expect(headers).toEqual(PROVIDER_LIFECYCLE_HEADERS);
    expect(headers[ORDER_STATUS_VIEW_HEADER]).toBe("1");
  });

  it("fulfills an order straight from input-required on a signed completion", async () => {
    expect(() => assertTransition("INPUT_REQUIRED", "FULFILLED")).not.toThrow();
    const { service, order, listing, transition } = harness();
    const now = Math.floor(Date.now() / 1000);
    const terminal = { orderId: "ord", taskId: "task", state: "completed", resultHash: hash("2"), completedAt: now - 5 };
    const { response } = await signed("completed", {
      terminalAttestation: { payload: terminal, signature: await signer.signMessage({ message: { raw: canonicalHash(terminal) } }) },
    });

    await expect(service.applyLifecycleResult(order, listing, response, "status", "handle"))
      .resolves.toMatchObject({ orderState: "FULFILLED" });
    expect(transition).toHaveBeenCalledWith(order, "FULFILLED", "provider_terminal_completed");
  });
});
