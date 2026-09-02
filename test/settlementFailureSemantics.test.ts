import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { StandardRailService } from "../src/standardRail/service.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const payer = getAddress(`0x${"22".repeat(20)}`);

// The private pipeline methods are exercised directly on a prototype-backed
// instance whose collaborators are replaced field by field.
interface ServiceHarness {
  settleClaimedOrder(args: Record<string, unknown>): Promise<StandardOrderRecord>;
  resumePaidOrder(order: StandardOrderRecord): Promise<void>;
}

function harness(fields: Record<string, unknown>): ServiceHarness {
  const service = Object.create(StandardRailService.prototype) as unknown as ServiceHarness;
  Object.assign(service, fields);
  return service;
}

type LockOutcome = { acquired: boolean; result?: unknown };

const listing = {
  registrationId: "reg-1",
  commitment: { payload: { canonicalToken: `0x${"33".repeat(20)}`, outcomeId: "outcome" } },
  deadlinePolicy: { settlementEvidenceSeconds: 900, releaseEvidenceSeconds: 900 },
} as unknown as StandardListing;

function claimedOrder(state: StandardOrderRecord["state"]): StandardOrderRecord {
  return {
    orderId: "ord_1",
    intentId: "int_1",
    orderKey: hash("5"),
    state,
    payer,
    listingManifestHash: hash("4"),
    listing,
    depositEvidenceHash: null,
    settlementTxHash: null,
    updatedAt: new Date(),
  } as unknown as StandardOrderRecord;
}

function settlementHarness(overrides: Record<string, unknown>) {
  const transitions: Array<{ to: string; reason: string }> = [];
  const store = {
    transition: vi.fn(async (order: StandardOrderRecord, to: string, reason: string, changes = {}) => {
      transitions.push({ to, reason });
      return { ...order, state: to, ...changes } as StandardOrderRecord;
    }),
    releaseCapacity: vi.fn(async () => undefined),
    listingSettlementAvailable: vi.fn(async () => true),
    tryWithListingSettlementLock: vi.fn(async (_hash: Hex, work: () => Promise<unknown>): Promise<LockOutcome> =>
      ({ acquired: true, result: await work() })),
  };
  const journal = {
    markVerifyInvoked: vi.fn(async () => undefined),
    recordVerify: vi.fn(async () => undefined),
    markSettleInvoked: vi.fn(async () => true),
  };
  const service = harness({
    appConfig: { chainId: 84532, x402Network: "eip155:84532" },
    railConfig: { manifest: { activeRailProfile: { payload: {} } } },
    store,
    journal,
    facilitator: { verify: vi.fn(async () => ({ isValid: true, payer })) },
    screenParticipants: vi.fn(async () => undefined),
    verifyListingIdentity: vi.fn(async () => undefined),
    withRailFence: (work: () => Promise<unknown>) => work(),
    evidence: { authorizationUsed: vi.fn(async () => false) },
    ...overrides,
  });
  return { service, store, journal, transitions };
}

const settleArgs = () => ({
  order: claimedOrder("ATTEMPT_OPENED"),
  listing,
  requirements: {} as PaymentRequirements,
  authorization: { payer, nonce: hash("6") },
  body: {},
  payment: {} as PaymentPayload,
});

describe("settlement failure semantics after the authorization is claimed", () => {
  it("voids the claimed authorization when the facilitator cannot be reached, then asks for a new signature", async () => {
    const { service, store, journal, transitions } = settlementHarness({
      facilitator: { verify: vi.fn(async () => { throw new Error("ECONNRESET"); }) },
    });
    await expect(service.settleClaimedOrder(settleArgs())).rejects.toMatchObject({
      code: "FACILITATOR_REJECTED",
      status: 503,
      requiresNewSignature: true,
      paymentMayHaveSettled: false,
    });
    expect(transitions).toEqual([{ to: "VERIFY_REJECTED", reason: "facilitator_verify_unavailable" }]);
    expect(store.releaseCapacity).toHaveBeenCalledWith("ord_1");
    expect(journal.recordVerify).not.toHaveBeenCalled();
    expect(journal.markSettleInvoked).not.toHaveBeenCalled();
  });

  it("never asks for a new signature once the order is VERIFIED: a superseded listing means reconcile", async () => {
    const { service, transitions, journal } = settlementHarness({
      verifyListingIdentity: vi.fn(async () => { throw new Error("LISTING_SUPERSEDED"); }),
    });
    await expect(service.settleClaimedOrder(settleArgs())).rejects.toMatchObject({
      code: "PAYMENT_PENDING_RECONCILIATION",
      requiresNewSignature: false,
      paymentMayHaveSettled: true,
    });
    expect(transitions).toEqual([{ to: "VERIFIED", reason: "facilitator_verified" }]);
    expect(journal.markSettleInvoked).not.toHaveBeenCalled();
  });

  it("treats an RPC failure after verification the same way", async () => {
    const { service } = settlementHarness({
      evidence: { authorizationUsed: vi.fn(async () => { throw new Error("rpc unavailable"); }) },
    });
    await expect(service.settleClaimedOrder(settleArgs())).rejects.toMatchObject({
      code: "PAYMENT_PENDING_RECONCILIATION",
      requiresNewSignature: false,
      paymentMayHaveSettled: true,
    });
  });

  it("answers with the VERIFIED order at once when the listing's settlement lock is busy", async () => {
    const { service, store, journal } = settlementHarness({});
    store.tryWithListingSettlementLock.mockImplementationOnce(async () => ({ acquired: false }));
    await expect(service.settleClaimedOrder(settleArgs())).resolves.toMatchObject({ state: "VERIFIED" });
    expect(journal.markSettleInvoked).not.toHaveBeenCalled();
  });
});

describe("recovery of a deposit proven on chain without a facilitator settle record", () => {
  it("continues the order to DEPOSIT_FINAL instead of parking it in LEGAL_HOLD", async () => {
    const transitions: Array<{ to: string; reason: string; changes: Record<string, unknown> }> = [];
    const order = claimedOrder("SETTLEMENT_AMBIGUOUS");
    const service = harness({
      appConfig: { chainId: 84532 },
      assertRailFence: vi.fn(async () => undefined),
      resumePreSettlement: vi.fn(async (value: StandardOrderRecord) => value),
      paymentNonce: vi.fn(() => hash("6")),
      withRailFence: vi.fn(async () => { throw new Error("stop-before-release"); }),
      store: {
        tryWithListingSettlementLock: async (_hash: Hex, work: () => Promise<unknown>) =>
          ({ acquired: true, result: await work() }),
        findById: vi.fn(async () => order),
        transition: vi.fn(async (value: StandardOrderRecord, to: string, reason: string, changes = {}) => {
          transitions.push({ to, reason, changes });
          return { ...value, state: to, ...changes } as StandardOrderRecord;
        }),
      },
      journal: {
        settlementRecord: vi.fn(async () => null),
        recordEvidence: vi.fn(async () => undefined),
        loadEvidence: vi.fn(async () => ({ evidenceHash: hash("8") })),
      },
      evidence: {
        findSettlementTransaction: vi.fn(async () => hash("7")),
        proveDeposit: vi.fn(async () => ({ evidenceHash: hash("8") })),
      },
    });
    await expect(service.resumePaidOrder(order)).rejects.toThrow("stop-before-release");
    expect(transitions.map(({ to, reason }) => `${to}:${reason}`)).toEqual([
      "EXTERNAL_OR_UNPROVEN_DEPOSIT:exact_deposit_without_authenticated_facilitator_success",
      "DEPOSIT_FINAL:proven_deposit_accepted_as_settlement",
    ]);
    expect(transitions[0]!.changes).toEqual({ settlementTxHash: hash("7"), depositEvidenceHash: hash("8") });
  });
});
