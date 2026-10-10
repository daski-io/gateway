import { vi } from "vitest";
import type { PaymentPayload } from "@x402/core/types";
import { StandardRailService } from "../../src/standardRail/service.js";
import { StandardPurchaseResponses } from "../../src/standardRail/purchaseResponse.js";
import type { StandardOrderRecord } from "../../src/standardRail/types.js";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const hash = (n: string) => `0x${n.repeat(64)}` as const;
export const payer = `0x${"22".repeat(20)}`;
export const intentId = "int_12345678-1234-4123-8123-123456789abc";
export type Stage = "settlement" | "deposit" | "release" | "dispatch";

export function purchaseHarness(stage: Stage = "settlement") {
  const gate = deferred();
  const entered = deferred();
  const delayed = async () => { entered.resolve(); await gate.promise; };
  const pause = async (at: Stage) => { if (stage === at) await delayed(); };
  const listing = {
    requestSchema: { type: "object", properties: {}, additionalProperties: false },
    purchaseReadiness: null,
    commitment: { payload: { canonicalToken: payer, outcomeId: "outcome" } },
    manifest: { payload: { splitterAddress: payer } },
    capacityPolicy: { maxOpenOrders: 25 },
  };
  let current = {
    orderId: "order-1", orderKey: hash("1"), intentId, state: "CHALLENGE_ISSUED",
    providerAgentId: "7", outcomeId: "outcome", canonicalRequest: { sku: "one" },
    listingManifestHash: hash("2"), listing, grossAmount: "1000000",
    paymentPayloadHash: null, leaseFence: 0, version: 0,
    createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 300_000),
  } as unknown as StandardOrderRecord;
  let held = false;
  let settleInvoked = false;
  const handle = "handle-1";
  const payment = {
    accepted: { asset: payer }, payload: { authorization: { from: payer, nonce: hash("3") } },
    extensions: { "payment-identifier": { info: { id: intentId } } },
  } as unknown as PaymentPayload;
  const store = {
    findByIntentId: vi.fn(async () => ({ handle, order: current })),
    findByAuthorizationKey: vi.fn(async () => null),
    findById: vi.fn(async () => current),
    claimAuthorization: vi.fn(async (args: Partial<StandardOrderRecord> & { expectedVersion: number }) => {
      if (args.expectedVersion !== current.version) throw new Error("ORDER_TRANSITION_CONFLICT");
      current = { ...current, ...args, state: "ATTEMPT_OPENED", version: current.version + 1 };
      return current;
    }),
    leaseOrder: vi.fn(async () => {
      if (held) return null;
      held = true;
      current = { ...current, leaseFence: current.leaseFence + 1 };
      return current;
    }),
    renewLease: vi.fn(async () => held),
    releaseLease: vi.fn(async () => { held = false; }),
    transition: vi.fn(async (order: StandardOrderRecord, state: StandardOrderRecord["state"], _reason: string, patch = {}) => {
      if (order.version !== current.version || order.leaseFence !== current.leaseFence) throw new Error("ORDER_TRANSITION_CONFLICT");
      current = { ...current, ...patch, state, version: current.version + 1 };
      return current;
    }),
    listingSettlementFrozen: vi.fn(async () => false),
    releaseCapacity: vi.fn(async () => undefined),
  };
  const journal = {
    markVerifyInvoked: vi.fn(async () => undefined),
    recordVerify: vi.fn(async () => undefined),
    markSettleInvoked: vi.fn(async () => {
      const first = !settleInvoked; settleInvoked = true; return first;
    }),
    recordSettlement: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
  };
  const facilitator = {
    verify: vi.fn(async () => ({ isValid: true, payer })),
    settle: vi.fn(async () => {
      await pause("settlement");
      return { success: true, payer, transaction: hash("4"), network: "eip155:84532" };
    }),
  };
  const evidence = {
    authorizationUsed: vi.fn(async () => false),
    proveDeposit: vi.fn(async () => { await pause("deposit"); return { evidenceHash: hash("5") }; }),
    releaseAndProve: vi.fn(async () => {
      await pause("release");
      return { evidenceHash: hash("6"), transactionHash: hash("7"), providerNetAmount: 95n, daskiCommissionAmount: 5n };
    }),
  };
  const dispatch = vi.fn(async (order: StandardOrderRecord) => {
    order = await store.transition(order, "DISPATCH_STARTED", "dispatch_invocation_persisted");
    await pause("dispatch");
    return store.transition(order, "DISPATCHED", "dispatch_accepted");
  });
  const purchaseResponses = new StandardPurchaseResponses();
  const service = Object.create(StandardRailService.prototype) as StandardRailService;
  Object.assign(service, { releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    store, journal, facilitator, evidence, dispatch, purchaseResponses,
    appConfig: { publicUrl: "https://gateway.example", chainId: 84532, x402Network: "eip155:84532", usdc: { name: "USDC", version: "2" } },
    railConfig: { leaseSeconds: 45, encryptionKey: Buffer.alloc(32, 7),
      manifest: { activeRailProfile: { payload: { facilitatorProfileHash: hash("8") } } } },
    assertAdmissionOpen: vi.fn(), assertRailFence: vi.fn(async () => undefined),
    listing: vi.fn(async () => listing), screenParticipants: vi.fn(async () => undefined),
    verifyListingIdentity: vi.fn(async () => undefined),
    withRailFence: (work: () => Promise<unknown>) => work(),
    incidents: { record: vi.fn(async () => undefined) },
    reputationReader: { stop: vi.fn() }, recovery: { stop: vi.fn(async () => undefined) },
    reputationWorker: { stop: vi.fn(async () => undefined) },
  });
  const args = { providerAgentId: "7", outcomeId: "outcome", body: { sku: "one" }, payment };
  return { service, args, gate, entered, store, journal, facilitator, evidence, dispatch,
    responses: purchaseResponses, current: () => current, held: () => held };
}
