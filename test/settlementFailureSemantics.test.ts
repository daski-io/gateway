import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { facilitatorRefusalCode, StandardRailService } from "../src/standardRail/service.js";
import { FacilitatorHttpError } from "../src/standardRail/facilitator.js";
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
  Object.assign(service, { releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    salesOutage: { assertOpen: async () => undefined, status: async () => ({ salesOpen: true }) }, signerHealth: () => true }, fields);
  return service;
}


const listing = {
  registrationId: "reg-1",
  requestSchema: { type: "object", properties: {}, additionalProperties: false },
  purchaseReadiness: null,
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
    listingSettlementFrozen: vi.fn(async () => false),
  };
  const journal = {
    markVerifyInvoked: vi.fn(async () => undefined),
    recordVerify: vi.fn(async () => undefined),
    markSettleInvoked: vi.fn(async () => true),
  };
  const service = harness({
    appConfig: { publicUrl: "https://gateway.example", chainId: 84532, x402Network: "eip155:84532" },
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

  it("answers with the VERIFIED order and settles nothing while an unreleased legal hold freezes the listing", async () => {
    const { service, store, journal } = settlementHarness({});
    store.listingSettlementFrozen.mockResolvedValueOnce(true);
    await expect(service.settleClaimedOrder(settleArgs())).resolves.toMatchObject({ state: "VERIFIED" });
    expect(journal.markSettleInvoked).not.toHaveBeenCalled();
  });

  it("settles with no listing-wide lock: other orders of the listing settle side by side", async () => {
    const { service, store, journal } = settlementHarness({});
    await service.settleClaimedOrder(settleArgs()).catch(() => undefined);
    expect(store.listingSettlementFrozen).toHaveBeenCalledOnce();
    expect(journal.markSettleInvoked).toHaveBeenCalledOnce();
  });
});

describe("a settle call whose outcome the gateway cannot confirm", () => {
  const chainPolicy = {
    finalityConfirmations: 12,
    recoveryIntervalMs: 10_000,
    manifest: {
      activeRailProfile: { payload: {} },
      chainEvidencePolicy: { payload: { maximumSourceLagBlocks: 8, finalityBlockTimeSeconds: 2 } },
    },
  };
  const paymentValidBefore = (validBefore: unknown) =>
    ({ payload: { authorization: { validBefore } } } as unknown as PaymentPayload);

  it("tells the buyer when the outcome is expected and logs the facilitator's status, reason and id", async () => {
    const validBefore = Math.floor(Date.now() / 1_000) + 240;
    const { service, transitions } = settlementHarness({
      railConfig: chainPolicy,
      facilitator: {
        verify: vi.fn(async () => ({ isValid: true, payer })),
        settle: vi.fn(async () => {
          throw new FacilitatorHttpError("settle", 429, { reason: "rate_limited", correlationId: "cdp-1" });
        }),
      },
    });
    const error = await service.settleClaimedOrder({ ...settleArgs(), payment: paymentValidBefore(String(validBefore)) })
      .catch((caught: unknown) => caught) as Record<string, unknown> & { logContext: Record<string, unknown> };
    // Expiry, then 12 confirmations and 8 blocks of lag at 2 seconds, then a minute and the recovery interval.
    const knownBy = new Date((validBefore + 40) * 1_000 + 70_000).toISOString();
    expect(error).toMatchObject({
      code: "PAYMENT_PENDING_RECONCILIATION",
      requiresNewSignature: false,
      paymentMayHaveSettled: true,
      until: knownBy,
    });
    expect(error.retryAfterSeconds).toBeGreaterThan(340);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(350);
    expect(String(error.nextAction)).toContain("Do not sign again");
    expect(String(error.nextAction)).toContain("only once it shows NOT_SETTLED");
    expect(error.logContext).toMatchObject({
      orderId: "ord_1",
      outcomeExpectedBy: knownBy,
      facilitatorFailure: { errorName: "FacilitatorHttpError", status: 429, reason: "rate_limited", correlationId: "cdp-1" },
    });
    expect(transitions.at(-1)).toEqual({ to: "SETTLEMENT_AMBIGUOUS", reason: "settle_response_unknown" });
  });

  it("keeps the plain answer when the payment names no usable expiry", async () => {
    const { service } = settlementHarness({
      railConfig: chainPolicy,
      facilitator: {
        verify: vi.fn(async () => ({ isValid: true, payer })),
        // How node:https reports the facilitator timeout: an AbortError caused by the signal's TimeoutError.
        settle: vi.fn(async () => {
          throw Object.assign(new Error("The operation was aborted"), {
            name: "AbortError", code: "ABORT_ERR",
            cause: new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          });
        }),
      },
    });
    const error = await service.settleClaimedOrder({ ...settleArgs(), payment: paymentValidBefore("soon") })
      .catch((caught: unknown) => caught) as Record<string, unknown> & { logContext: Record<string, unknown> };
    expect(error).toMatchObject({ code: "PAYMENT_PENDING_RECONCILIATION", nextAction: expect.stringContaining("Reconcile") });
    expect(error.until).toBeUndefined();
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.logContext.facilitatorFailure).toEqual({
      errorName: "AbortError", message: "The operation was aborted", code: "ABORT_ERR", causeName: "TimeoutError",
    });
  });
});

describe("facilitator verify refusals (spec B4)", () => {
  it("maps signature refusals and undeployed smart wallets to the gateway's own codes", () => {
    expect(facilitatorRefusalCode({ invalidReason: "invalid_exact_evm_payload_signature" }))
      .toBe("SIGNATURE_INVALID");
    expect(facilitatorRefusalCode({
      invalidReason: "invalid_exact_evm_payload_signature",
      invalidMessage: "ErrUndeployedSmartWallet: smart wallet is not deployed",
    })).toBe("SIGNATURE_COUNTERFACTUAL_REJECTED");
    expect(facilitatorRefusalCode({ invalidReason: "insufficient_funds" })).toBe("FACILITATOR_REJECTED");
    expect(facilitatorRefusalCode({})).toBe("FACILITATOR_REJECTED");
  });

  it("answers a facilitator signature refusal as SIGNATURE_INVALID with the facilitator's reason", async () => {
    const { service, transitions, store } = settlementHarness({
      facilitator: {
        verify: vi.fn(async () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" })),
      },
    });
    await expect(service.settleClaimedOrder(settleArgs())).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
      phase: "facilitator_verify",
      facilitatorReason: "invalid_exact_evm_payload_signature",
      requiresNewSignature: true,
    });
    expect(transitions).toEqual([{ to: "VERIFY_REJECTED", reason: "facilitator_verify_rejected" }]);
    expect(store.releaseCapacity).toHaveBeenCalledWith("ord_1");
  });

  it("answers an undeployed smart wallet as the counterfactual refusal", async () => {
    const { service } = settlementHarness({
      facilitator: {
        verify: vi.fn(async () => ({
          isValid: false, invalidReason: "invalid_exact_evm_payload_signature",
          invalidMessage: "ErrUndeployedSmartWallet",
        })),
      },
    });
    await expect(service.settleClaimedOrder(settleArgs())).rejects.toMatchObject({
      code: "SIGNATURE_COUNTERFACTUAL_REJECTED",
      facilitatorReason: "invalid_exact_evm_payload_signature",
    });
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
      store: {
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
        releaseAndProve: vi.fn(async () => { throw new Error("stop-before-release"); }),
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

describe("settlement during a sales outage", () => {
  const until = new Date(Date.now() + 600_000).toISOString();
  const paused = () => ({
    assertOpen: vi.fn(async (phase: string, options: { captured?: boolean } = {}) => {
      const { salesPausedError } = await import("../src/standardRail/errors.js");
      throw salesPausedError({ reason: "Provider identity switch", until, retryAfterSeconds: 600, phase: phase as never,
        captured: options.captured });
    }),
    status: vi.fn(async () => ({ salesOpen: false, reason: "Provider identity switch", since: until, until })),
  });

  it("refuses to submit a claimed authorization once the database reports an outage, and says it may still settle", async () => {
    const refusal = Object.assign(new Error("SALE_SUSPENDED"), {
      code: "P0001", detail: "SALES_PAUSED", hint: JSON.stringify({ reason: "Provider identity switch", since: until, until }),
    });
    const { service, journal, transitions } = settlementHarness({});
    journal.markSettleInvoked.mockRejectedValueOnce(refusal);
    const error = await service.settleClaimedOrder(settleArgs()).then(() => null, (caught: unknown) => caught);
    // The authorization is captured and settles after the outage while it is
    // valid: the buyer reconciles and never signs again.
    expect(error).toMatchObject({ code: "SALES_PAUSED", status: 503, phase: "facilitator_settle", retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: true, until, reason: "Provider identity switch" });
    expect((error as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(590);
    expect((error as { nextAction: string }).nextAction).toMatch(/^Do not sign again/);
    expect(transitions).toEqual([{ to: "VERIFIED", reason: "facilitator_verified" }]);
    expect(journal.markSettleInvoked).toHaveBeenCalledOnce();
  });

  it("reads no outage state of its own on the request path: a failing read cannot answer for a captured payment", async () => {
    const outage = { assertOpen: vi.fn(async () => { throw new Error("pool exhausted"); }), status: vi.fn() };
    const { service, journal } = settlementHarness({ salesOutage: outage });
    await service.settleClaimedOrder(settleArgs()).catch(() => undefined);
    expect(outage.assertOpen).not.toHaveBeenCalled();
    expect(journal.markSettleInvoked).toHaveBeenCalledOnce();
  });

  it("keeps a scoped stop's answer: the VERIFIED order, nothing submitted", async () => {
    const { service, journal } = settlementHarness({});
    journal.markSettleInvoked.mockRejectedValueOnce(Object.assign(new Error("SALE_SUSPENDED"), { code: "P0001" }));
    await expect(service.settleClaimedOrder(settleArgs())).resolves.toMatchObject({ state: "VERIFIED" });
  });

  it("leaves a claimed authorization unsubmitted in recovery while sales are paused", async () => {
    const order = { ...claimedOrder("VERIFIED"), encryptedPaymentPayload: Buffer.from("x"), paymentPayloadHash: hash("a") };
    const verify = vi.fn();
    const markSettleInvoked = vi.fn();
    const service = harness({
      salesOutage: paused(),
      storedPayment: vi.fn(() => ({})),
      paymentAuthorizationValidBefore: vi.fn(() => Math.floor(Date.now() / 1_000) + 600),
      facilitator: { verify },
      journal: { markSettleInvoked },
    }) as unknown as { resumePreSettlement(order: StandardOrderRecord, listing: StandardListing): Promise<StandardOrderRecord> };
    await expect(service.resumePreSettlement(order, listing)).resolves.toBe(order);
    expect(verify).not.toHaveBeenCalled();
    expect(markSettleInvoked).not.toHaveBeenCalled();
  });

  it("waits quietly in recovery while paused, but still looks for a deposit relayed meanwhile", async () => {
    const order = { ...claimedOrder("VERIFIED"), encryptedPaymentPayload: Buffer.from("x"), paymentPayloadHash: hash("a") };
    const findSettlementTransaction = vi.fn(async () => null);
    const recovery = (salesOutage: unknown) => harness({
      salesOutage,
      appConfig: { chainId: 84532 },
      railConfig: { finalityConfirmations: 12, manifest: { chainEvidencePolicy: { payload: {
        maximumSourceLagBlocks: 10, finalityBlockTimeSeconds: 2 } } } },
      assertRailFence: vi.fn(async () => undefined),
      resumePreSettlement: vi.fn(async (value: StandardOrderRecord) => value),
      paymentNonce: vi.fn(() => hash("6")),
      paymentAuthorizationValidBefore: vi.fn(() => Math.floor(Date.now() / 1_000) + 600),
      store: { findById: vi.fn(async () => order) },
      journal: { settlementRecord: vi.fn(async () => null) },
      evidence: { findSettlementTransaction },
    });
    await expect(recovery(paused()).resumePaidOrder(order)).resolves.toBeUndefined();
    expect(findSettlementTransaction).toHaveBeenCalledOnce();
    const open = { assertOpen: vi.fn(async () => undefined), status: vi.fn(async () => ({ salesOpen: true })) };
    await expect(recovery(open).resumePaidOrder(order)).rejects.toThrow("Settlement authorization is not final");
  });
});
