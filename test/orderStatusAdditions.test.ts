import { COMMITTED_KEYS_ONLY } from "../src/standardRail/providerAuthority.js";
import { describe, expect, it, vi } from "vitest";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { canonicalHash } from "../src/standardRail/canonical.js";
import {
  ORDER_STATUS_ADDITIONS_HEADER, ORDER_STATUS_VIEW_HEADER, PROVIDER_LIFECYCLE_HEADERS, salesTaxAddsUp, salesTaxSchema,
} from "../src/standardRail/orderStatusView.js";
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
// A Denver sale of $40.00: Colorado tax included in the $43.66 the order paid.
const GROSS = "43660000";
const SALES_TAX = {
  schemaVersion: 1, state: "CO", jurisdictionCode: "01-0006", priceUsd: "40.00", taxableAmountUsd: "40.00",
  jurisdictions: [
    { name: "Colorado", type: "state", rate: "0.029", taxUsd: "1.16" },
    { name: "Denver", type: "city", rate: "0.0515", taxUsd: "2.06" },
    { name: "Regional Transportation District", type: "district", rate: "0.01", taxUsd: "0.40" },
    { name: "Scientific and Cultural Facilities District", type: "district", rate: "0.001", taxUsd: "0.04" },
  ],
  fees: [], totalTaxUsd: "3.66", totalFeesUsd: "0.00", totalUsd: "3.66", paidUsd: "43.66", includedInPaidAmount: true,
};

type Apply = (order: StandardOrderRecord, listing: StandardListing, response: unknown, action: string, handle: string) => Promise<Record<string, unknown>>;

function harness(orderState: StandardOrderRecord["state"] = "INPUT_REQUIRED") {
  const persistOperations = vi.fn(async () => undefined);
  const transition = vi.fn(async (order: StandardOrderRecord, to: StandardOrderRecord["state"]) => ({ ...order, state: to }));
  const service = Object.assign(Object.create(StandardRailService.prototype), {providerWallets:COMMITTED_KEYS_ONLY,
    releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    salesOutage: { assertOpen: async () => undefined, status: async () => ({ salesOpen: true }) }, signerHealth: () => true,
    store: { persistOperations, transition }, validateResponse: vi.fn(async () => undefined), signedReceipt: async () => null,
    confirmationState: { stored: async () => null }, submissionStatus: async () => null,
  }) as { applyLifecycleResult: Apply };
  const order = { orderId: "ord", providerTaskId: "task", state: orderState, orderKey: hash("1"), grossAmount: GROSS } as StandardOrderRecord;
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
    const service = Object.assign(Object.create(StandardRailService.prototype), {providerWallets:COMMITTED_KEYS_ONLY,
      assertRailFence: async () => undefined,
      store: { findByHandle: async () => order },
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: { encryptionKey: key, gatewayAudience: "gateway.example", environment: "testnet",
        signers: localGatewaySigners(`0x${"34".repeat(32)}`), dispatchTimeoutMs: 3_000 },
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
    expect(headers[ORDER_STATUS_ADDITIONS_HEADER]).toBe("salesTax");
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

describe("sales tax on the order status", () => {
  it("passes the provider's statement through on a status read without storing it", async () => {
    const { service, order, listing, persistOperations } = harness("DISPATCHED");
    const { payload, response } = await signed("working", { salesTax: SALES_TAX });

    const body = await service.applyLifecycleResult(order, listing, response, "status", "handle");

    expect(body).toMatchObject({ salesTax: SALES_TAX, orderState: "DISPATCHED" });
    expect(persistOperations).toHaveBeenCalledExactlyOnceWith("ord", payload.operations, null);
  });

  it("carries it beside the other additions and on an order input answer", async () => {
    const { service, order, listing } = harness();
    const { response } = await signed("input-required", { inputRequest: INPUT_REQUEST, documents: DOCUMENTS, salesTax: SALES_TAX });

    await expect(service.applyLifecycleResult(order, listing, response, "input", "handle"))
      .resolves.toMatchObject({ inputRequest: INPUT_REQUEST, documents: DOCUMENTS, salesTax: SALES_TAX });
  });

  it("keeps a status read without tax exactly as before", async () => {
    const { service, order, listing } = harness("DISPATCHED");
    const { response } = await signed("working", {});

    const body = await service.applyLifecycleResult(order, listing, response, "status", "handle");

    expect(Object.keys(body).sort()).toEqual([
      "confirmationFinal", "fulfillmentState", "operations", "orderHandle", "orderId", "orderKey", "orderState",
      "receipt", "signature", "state", "submission", "taskId",
    ]);
  });

  it("refuses it on a cancellation", async () => {
    const { service, order, listing } = harness("DISPATCHED");
    const { response } = await signed("working", { salesTax: SALES_TAX });

    await expect(service.applyLifecycleResult(order, listing, response, "cancel", "handle"))
      .rejects.toThrow("PROVIDER_LIFECYCLE_UNEXPECTED_CONTENT");
  });

  const changed = (patch: Record<string, unknown>) => ({ ...SALES_TAX, ...patch });
  it.each([
    ["jurisdiction taxes that miss the total", changed({ totalTaxUsd: "3.67", totalUsd: "3.67", paidUsd: "43.67" })],
    ["fees that miss their total", changed({ totalFeesUsd: "0.31" })],
    ["a total that is not tax plus fees", changed({ totalUsd: "3.60" })],
    ["a price and total that miss the paid amount", changed({ priceUsd: "40.01" })],
    ["a paid amount that is not the order's gross", changed({ priceUsd: "39.00", taxableAmountUsd: "39.00", paidUsd: "42.66" })],
    ["a taxable amount above the price", changed({ taxableAmountUsd: "40.01" })],
    ["tax said to be charged apart", changed({ includedInPaidAmount: false })],
    ["an amount in floating point", changed({ totalFeesUsd: "0" })],
    ["a rate of 100% or more", changed({ jurisdictions: [{ ...SALES_TAX.jurisdictions[0], rate: "1.5" }] })],
    ["an extra key", changed({ address: "1437 Bannock St" })],
  ])("refuses a statement with %s without echoing it", async (_name, salesTax) => {
    const { service, order, listing } = harness("DISPATCHED");
    const { response } = await signed("working", { salesTax });

    const error = await service.applyLifecycleResult(order, listing, response, "status", "handle").catch((caught: unknown) => caught);

    expect(String((error as Error).message)).toContain("PROVIDER_ORDER_STATUS_VIEW_INVALID");
    expect(JSON.stringify(error)).not.toContain("Bannock");
    expect(JSON.stringify(error)).not.toContain("Denver");
  });

  it("checks the sums exactly, sub-cent digits and line rates included", () => {
    const statement = salesTaxSchema.parse({
      ...SALES_TAX, priceUsd: "40.000001", taxableAmountUsd: "25.00", paidUsd: "43.660001",
      jurisdictions: [
        { name: "Colorado", type: "state", rate: "0.029", taxUsd: "1.16" },
        { name: "Denver", type: "city", rate: "0.0515 / 0.04", taxUsd: "2.50" },
      ],
    });
    expect(salesTaxAddsUp(statement, "43660001")).toBe(true);
    expect(salesTaxAddsUp(statement, "43660000")).toBe(false);
    expect(salesTaxAddsUp(statement, "4.366e7")).toBe(false);
  });
});
