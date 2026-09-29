import { describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload } from "@x402/core/types";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { createPayerSignatureVerifier } from "../src/standardRail/payerSignature.js";
import { StandardRailService } from "../src/standardRail/service.js";
import type {
  StandardListing,
  StandardOrderRecord,
} from "../src/standardRail/types.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => `0x${byte.repeat(40)}` as Hex;

type ServiceHarness = StandardRailService & Record<string, unknown>;

function harness(fields: Record<string, unknown>): ServiceHarness {
  const service = Object.create(StandardRailService.prototype) as ServiceHarness;
  Object.assign(service, fields);
  return service;
}

describe("standard rail orchestration", () => {
  it("reuses an open challenge without creating a duplicate order", async () => {
    const listing = {
      commitment: { payload: { absoluteResourceUri: "https://gateway.example/buy" } },
      manifest: {},
      offer: {},
      deadlinePolicy: { minimumPaymentWindowSeconds: 30 },
    } as unknown as StandardListing;
    const order = { orderId: "order-1" } as StandardOrderRecord;
    const challenge = { handle: "handle-1", order, paymentRequired: { status: 402 } };
    const findOpenDraft = vi.fn(async () => ({ handle: "handle-1", order }));
    const createDraft = vi.fn();
    const service = harness({
      railConfig: { manifest: { activeRailProfile: { payload: { railEpoch: "7" } } } },
      assertAdmissionOpen: vi.fn(),
      assertRailFence: vi.fn(async () => undefined),
      listing: vi.fn(() => listing),
      verifyListingIdentity: vi.fn(async () => undefined),
      validateRequest: vi.fn(),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined), findOpenDraft, createDraft },
      challengeResponse: vi.fn(() => challenge),
    });

    await expect(service.issueChallenge({
      providerAgentId: "7",
      outcomeId: "outcome",
      body: { sku: "one" },
    })).resolves.toBe(challenge);
    expect(findOpenDraft).toHaveBeenCalledOnce();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it("returns an identical payment authorization as a replay", async () => {
    const body = { sku: "one" };
    const payment = {
      accepted: { asset: address("1") },
      payload: {
        authorization: {
          from: address("2"),
          nonce: hash("3"),
        },
      },
      extensions: {
        "payment-identifier": {
          info: { required: true, id: "int_12345678-1234-4123-8123-123456789abc" },
          schema: { type: "object" },
        },
      },
    } as unknown as PaymentPayload;
    const order = {
      orderId: "order-1",
      providerAgentId: "7",
      outcomeId: "outcome",
      canonicalRequest: body,
      intentId: "int_12345678-1234-4123-8123-123456789abc",
      paymentPayloadHash: canonicalHash(payment),
    } as StandardOrderRecord;
    const existing = { handle: "handle-1", order };
    const service = harness({
      appConfig: { chainId: 84532 },
      assertAdmissionOpen: vi.fn(),
      assertRailFence: vi.fn(async () => undefined),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined), findByIntentId: vi.fn(async () => existing) },
      incidents: { record: vi.fn() },
    });

    await expect(service.submitPayment({
      providerAgentId: "7",
      outcomeId: "outcome",
      body,
      payment,
    })).resolves.toEqual({ ...existing, replay: true });

    const changedPayment = {
      ...payment,
      payload: {
        ...(payment.payload as Record<string, unknown>),
        transportAttempt: "different-authorization",
      },
    } as unknown as PaymentPayload;
    await expect(service.submitPayment({
      providerAgentId: "7",
      outcomeId: "outcome",
      body,
      payment: changedPayment,
    })).rejects.toMatchObject({ code: "PAYMENT_IDENTIFIER_CONFLICT" });
  });

  it("refuses an identifier the gateway never issued as unknown, not as a conflict", async () => {
    // @daski/pay 0.1.0 minted `daski-<hex>` identifiers instead of carrying
    // the challenge's `int_<uuid>`; the old conflict answer, with
    // paymentMayHaveSettled: true, sent the agent reconciling a payment that
    // never existed (2026-09-04).
    const body = { sku: "one" };
    const payment = {
      accepted: { asset: address("1") },
      payload: { authorization: { from: address("2"), nonce: hash("3") } },
      extensions: {
        "payment-identifier": {
          info: { required: true, id: "daski-e1f3f326f4e5ea9a5546bbb34538daaf" },
          schema: { type: "object" },
        },
      },
    } as unknown as PaymentPayload;
    const findByIntentId = vi.fn(async () => null);
    const findByAuthorizationKey = vi.fn();
    const service = harness({
      appConfig: { chainId: 84532 },
      assertAdmissionOpen: vi.fn(),
      assertRailFence: vi.fn(async () => undefined),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined), findByIntentId, findByAuthorizationKey },
      incidents: { record: vi.fn() },
    });

    await expect(service.submitPayment({
      providerAgentId: "7",
      outcomeId: "outcome",
      body,
      payment,
    })).rejects.toMatchObject({
      code: "PAYMENT_IDENTIFIER_UNKNOWN",
      status: 400,
      field: "payment-identifier",
      publicMessage: "Payment identifier daski-e1f3f326f4e5ea9a5546bbb34538daaf was not issued by this gateway",
      retryable: true,
      requiresNewSignature: false,
      paymentMayHaveSettled: false,
    });
    expect(findByIntentId).toHaveBeenCalledWith("daski-e1f3f326f4e5ea9a5546bbb34538daaf");
    // Nothing was looked up by authorization: the submission never got that far.
    expect(findByAuthorizationKey).not.toHaveBeenCalled();
  });

  it("keeps a known identifier bound to a different request as a conflict", async () => {
    const payment = {
      accepted: { asset: address("1") },
      payload: { authorization: { from: address("2"), nonce: hash("3") } },
      extensions: {
        "payment-identifier": {
          info: { required: true, id: "int_12345678-1234-4123-8123-123456789abc" },
          schema: { type: "object" },
        },
      },
    } as unknown as PaymentPayload;
    const order = {
      orderId: "order-1",
      providerAgentId: "7",
      outcomeId: "outcome",
      canonicalRequest: { sku: "one" },
      intentId: "int_12345678-1234-4123-8123-123456789abc",
    } as StandardOrderRecord;
    const service = harness({
      appConfig: { chainId: 84532 },
      assertAdmissionOpen: vi.fn(),
      assertRailFence: vi.fn(async () => undefined),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined), findByIntentId: vi.fn(async () => ({ handle: "handle-1", order })) },
      incidents: { record: vi.fn() },
    });

    await expect(service.submitPayment({
      providerAgentId: "7",
      outcomeId: "outcome",
      body: { sku: "two" },
      payment,
    })).rejects.toMatchObject({
      code: "PAYMENT_IDENTIFIER_CONFLICT",
      status: 409,
      paymentMayHaveSettled: true,
    });
  });

  it("round-trips sign-ready order actions and grant-read capability access", async () => {
    const account = privateKeyToAccount(
      `0x${"11".repeat(32)}` as Hex,
    );
    const request = {};
    const action = "status" as const;
    const order = {
      orderId: "order-1",
      payer: account.address,
      state: "FULFILLED",
      capabilityEpoch: 0,
    } as StandardOrderRecord;
    const receipt = { artifactType: "StandardRailReceiptV2" };
    const issueActionChallenge = vi.fn(async () => undefined);
    const consumeActionChallenge = vi.fn(async () => undefined);
    const service = harness({
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: {
        gatewayAudience: "gateway.example",
        encryptionKey: Buffer.alloc(32, 7),
        orderReadCapTtlSeconds: 1_800,
        abuse: {
          walletChallengesOutstandingGlobal: 1_000,
        },
      },
      assertRailFence: vi.fn(async () => undefined),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined), findByHandle: vi.fn(async () => order) },
      journal: { issueActionChallenge, consumeActionChallenge, assertActionChallengeOpen: vi.fn(async () => undefined) },
      incidents: { record: vi.fn() },
      signedReceipt: vi.fn(async () => receipt),
      payerSignature: createPayerSignatureVerifier({ accountTypes: ["eoa"], timeoutMs: 0, endpoints: [] }),
      confirmationState: { stored: vi.fn(async () => null) },
    });
    const challenge = await service.issueActionChallenge({
      handle: "handle-1",
      action,
      request,
      clientKey: "test-client",
    }) as Record<string, unknown> & {
      signRequest: Parameters<typeof account.signTypedData>[0];
    };
    const { signRequest, ...authorization } = challenge;
    const signature = await account.signTypedData(signRequest);
    expect(issueActionChallenge).toHaveBeenCalledOnce();

    await expect(service.performAction({
      handle: "handle-1",
      action,
      request,
      authorization: { ...authorization, signature } as never,
    })).resolves.toEqual({ orderHandle: "handle-1", state: "FULFILLED", receipt, confirmationFinal: null });

    const grantChallenge = await service.issueActionChallenge({
      handle: "handle-1",
      action: "grant-read",
      request,
      clientKey: "test-client",
    }) as Record<string, unknown> & {
      signRequest: Parameters<typeof account.signTypedData>[0];
    };
    const {
      signRequest: grantSignRequest,
      ...grantAuthorization
    } = grantChallenge;
    const grantSignature = await account.signTypedData(grantSignRequest);
    const access = await service.performAction({
      handle: "handle-1",
      action: "grant-read",
      request,
      authorization: {
        ...grantAuthorization,
        signature: grantSignature,
      } as never,
    }) as {
      readCapability: string;
      expiresAt: number;
      scope: string[];
      orderHandle: string;
    };
    expect(access).toMatchObject({
      orderHandle: "handle-1",
      scope: ["status", "artifact"],
    });
    await expect(service.performAction({
      handle: "handle-1",
      action: "status",
      request,
      readCapability: access.readCapability,
    })).resolves.toEqual({ orderHandle: "handle-1", state: "FULFILLED", receipt, confirmationFinal: null });
    expect(issueActionChallenge).toHaveBeenCalledTimes(2);
    expect(consumeActionChallenge).toHaveBeenCalledTimes(2);
  });

  it("names a provider quote decline separately from quote infrastructure failure", async () => {
    const listing = {
      runtimeCommitmentHash: hash("1"),
      offer: { payload: { pricingMode: "dynamic", fixedGrossAmount: "0" } },
      commitment: { payload: { outcomeId: "register-domain", commissionBps: 500 } },
      providerControlProfile: {
        payload: {
          providerAudience: "provider.example",
          quoteUrl: "https://provider.example/quote",
          timeoutMs: 3_000,
          maxResponseBytes: 65_536,
        },
      },
    } as unknown as StandardListing;
    const quoteStatus = { value: 409 };
    const service = harness({
      appConfig: { chainId: 84532 },
      railConfig: {
        environment: "testnet",
        dispatchPrivateKey: `0x${"11".repeat(32)}`,
        dispatchTimeoutMs: 5_000,
      },
      providerFetch: vi.fn(async () => ({ ok: false, status: quoteStatus.value })),
    });
    const resolve = (service as unknown as {
      resolveGrossAmount(value: StandardListing, body: unknown): Promise<unknown>;
    }).resolveGrossAmount.bind(service);

    await expect(resolve(listing, { domain: "already-consumed.example" }))
      .rejects.toMatchObject({ code: "PROVIDER_QUOTE_REJECTED" });
    quoteStatus.value = 503;
    await expect(resolve(listing, { domain: "already-consumed.example" }))
      .rejects.toMatchObject({ code: "PROVIDER_QUOTE_UNAVAILABLE" });
  });

  it.each(["manual", "automatic"])("binds %s mailbox DNS setup into the provider readiness quote", async dnsSetup => {
    // 2026-09-03: a mailbox on an unverified custom domain was quoted from the
    // offer alone, paid, and refused at fulfilment. The provider's quote for
    // the request carries the adapter's availability verdict; the challenge
    // keeps the offer price while binding the provider readiness quote.
    const providerAuthority = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const listing = {
      runtimeCommitmentHash: hash("1"),
      offer: { payload: { pricingMode: "fixed", fixedGrossAmount: "9990000" } },
      commitment: {
        payload: {
          outcomeId: "create-mailbox",
          providerAgentId: "8327",
          commissionBps: 500,
          providerAuthorityKey: providerAuthority.address,
        },
      },
      deadlinePolicy: { draftSeconds: 300, minimumPaymentWindowSeconds: 30 },
      quotePolicy: null,
      providerControlProfile: {
        payload: {
          providerAudience: "provider.example",
          quoteUrl: "https://provider.example/quote",
          timeoutMs: 3_000,
          maxResponseBytes: 65_536,
        },
      },
    } as unknown as StandardListing;
    const body = { address: "conformance-probe@sandbox.daski.io", dnsSetup };
    const requestHash = canonicalHash(body);
    const answer = { status: 200, grossAmount: "9990000", delaySeconds: 0, payer: null as string | null, lifetime: 60 };
    const providerFetch = vi.fn(async (_listing: unknown, _url: string, init: RequestInit) => {
      const envelope = JSON.parse(String(init.body)).request;
      expect(envelope.payload.request).toHaveProperty("dnsSetup");
      expect(envelope.payload.requestHash).toBe(canonicalHash(envelope.payload.request));
      if (answer.status === 422) {
        return new Response(JSON.stringify({
          fieldErrors: [{ path: "address", rule: "dns_unverified", message: "The domain is not configured for mail." }],
        }), { status: 422, headers: { "content-type": "application/json" } });
      }
      if (answer.status !== 200) return new Response("", { status: answer.status });
      const now = Math.floor(Date.now() / 1_000);
      const payload = {
        outcomeId: "create-mailbox",
        listingManifestHash: hash("1"),
        requestHash,
        grossAmount: answer.grossAmount,
        payer: answer.payer,
        issuedAt: now,
        validBefore: now + answer.lifetime,
      };
      const signature = await providerAuthority.signMessage({ message: { raw: canonicalHash(payload) } });
      if (answer.delaySeconds) vi.setSystemTime(Date.now()+answer.delaySeconds*1000);
      return new Response(JSON.stringify({ ...payload, signature }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const service = harness({
      appConfig: { chainId: 84532 },
      railConfig: {
        environment: "testnet",
        dispatchPrivateKey: `0x${"11".repeat(32)}`,
        dispatchTimeoutMs: 5_000,
      },
      providerFetch,
    });
    const resolve = (service as unknown as {
      resolveGrossAmount(value: StandardListing, body: unknown): Promise<{
        grossAmount: string; providerQuoteHash: Hex; issuedAt: number; validBefore: number;
      }>;
    }).resolveGrossAmount.bind(service);

    const before = Math.floor(Date.now() / 1_000);
    const pricing = await resolve(listing, body);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(providerFetch.mock.calls[0]![2].body)).request.payload.request).toEqual(body);
    // A quote for one setup mode cannot authorize the other.
    await expect(resolve(listing, { ...body, dnsSetup: dnsSetup === "manual" ? "automatic" : "manual" }))
      .rejects.toMatchObject({ code: "PROVIDER_QUOTE_UNAVAILABLE" });
    expect(pricing.grossAmount).toBe("9990000");
    expect(pricing.providerQuoteHash).not.toBe(`0x${"00".repeat(32)}`);
    expect(pricing.validBefore).toBeGreaterThanOrEqual(before + 60);
    expect(pricing.validBefore).toBeLessThanOrEqual(before + 61);
    // A fixed readiness quote may span the sealed five-minute draft window, never longer.
    answer.lifetime = 300;
    const drafted = await resolve(listing, body);
    expect(drafted.validBefore).toBeGreaterThanOrEqual(before + 300);
    answer.lifetime = 301;
    await expect(resolve(listing, body)).rejects.toMatchObject({code:"PROVIDER_QUOTE_UNAVAILABLE"});
    answer.lifetime = 60;
    answer.payer = address("b");
    await expect(resolve(listing, body)).rejects.toMatchObject({code:"PROVIDER_QUOTE_UNAVAILABLE"});
    answer.payer = null;
    vi.useFakeTimers({toFake:["Date"]});
    try {
      answer.delaySeconds=31;
      await expect(resolve(listing, body)).rejects.toMatchObject({code:"PROVIDER_QUOTE_UNAVAILABLE"});
    } finally { answer.delaySeconds=0; vi.useRealTimers(); }

    // the provider's availability refusal reaches the buyer before any payment
    answer.status = 422;
    await expect(resolve(listing, body)).rejects.toMatchObject({
      code: "PROVIDER_QUOTE_REJECTED",
      fieldErrors: [{ path: "address", rule: "dns_unverified" }],
    });
    answer.status = 503;
    await expect(resolve(listing, body)).rejects.toMatchObject({ code: "PROVIDER_QUOTE_UNAVAILABLE" });

    // a provider that quotes a fixed listing at another amount is not trusted over the offer
    answer.status = 200;
    answer.grossAmount = "5000000";
    await expect(resolve(listing, body)).rejects.toMatchObject({ code: "PROVIDER_QUOTE_UNAVAILABLE" });
  });

  it("resumes a paid dispatched order through the dispatcher seam", async () => {
    const order = {
      orderId: "order-1",
      state: "DISPATCHED",
      listingManifestHash: hash("1"),
      listing: { deadlinePolicy: { fulfillmentSeconds: 300 } },
      updatedAt: new Date(),
    } as unknown as StandardOrderRecord;
    const dispatch = { payload: { orderId: order.orderId } };
    const reconcile = vi.fn(async () => ({ ...order, state: "FULFILLED" }));
    const service = harness({
      assertRailFence: vi.fn(async () => undefined),
      resumePreSettlement: vi.fn(async () => order),
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined),
        tryWithListingSettlementLock: async (
          _listingHash: Hex,
          action: () => Promise<void>,
        ) => ({ acquired: true, result: await action() }),
        findById: vi.fn(async () => order),
        transition: vi.fn(),
      },
      journal: {
        dispatchClaim: vi.fn(async () => ({ dispatch })),
        dispatchResolvedAt: vi.fn(async () => order.updatedAt),
      },
      dispatcher: { reconcile },
    });
    const resume = (service as unknown as {
      resumePaidOrder(value: StandardOrderRecord): Promise<void>;
    }).resumePaidOrder.bind(service);

    await expect(resume(order)).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledOnce();
  });
});


describe("live fulfillment deadline", () => {
  it("keeps an admitted DNS wait pending after 31 days and alerts when its progress is stale", async () => {
    const now = Math.floor(Date.now()/1000);
    const order = { orderId:"waiting", state:"DISPATCHED", providerAgentId:"7", outcomeId:"mailbox",
      listingManifestHash:hash("1"), listing:{purchaseReadiness:"payer_dns"},
      updatedAt:new Date((now-31*86400)*1000) } as unknown as StandardOrderRecord;
    const transition=vi.fn(); const record=vi.fn();
    const service=harness({ assertRailFence:async()=>undefined,resumePreSettlement:async()=>order,
      listing:async()=>({deadlinePolicy:{fulfillmentSeconds:30*86400}}),
      store:{tryWithListingSettlementLock:async(_hash:Hex,work:()=>Promise<void>)=>work(),findById:async()=>order,
        transition,loadOperations:async()=>({accumulatedWaitSeconds:31*86400,operations:{observedAt:now-700,
          fulfillment:{phase:"dns_pending",accumulatedWaitSeconds:31*86400,nextCheckAt:now-400}}})},
      journal:{dispatchClaim:async()=>({dispatch:{}}),dispatchResolvedAt:async()=>order.updatedAt},
      dispatcher:{reconcile:async()=>{throw new Error("offline");}},incidents:{record},
    });
    await (service as unknown as {resumePaidOrder(o:StandardOrderRecord):Promise<void>}).resumePaidOrder(order);
    expect(transition).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledExactlyOnceWith({kind:"provider_wait_progress_stale",orderId:"waiting",state:"DISPATCHED"});
  });
  it.each(["DISPATCHED", "INPUT_REQUIRED"] as const)("keeps an old snapshot alive at 61 minutes in %s and fails at 30 days", async (state) => {
    const resolvedAt = new Date("2026-09-28T00:00:36Z");
    const order = {
      orderId: "order-1", providerAgentId: "7", outcomeId: "formation", state,
      listingManifestHash: hash("1"),
      listing: { deadlinePolicy: { fulfillmentSeconds: 3600 } }, updatedAt: resolvedAt,
    } as unknown as StandardOrderRecord;
    const currentListing = vi.fn(async () => ({ deadlinePolicy: { fulfillmentSeconds: 2_592_000 } }));
    const reconcile = vi.fn(async () => order);
    const transition = vi.fn();
    const service = harness({
      assertRailFence: vi.fn(), resumePreSettlement: async () => order,
      listing: currentListing,
      store: { loadOperations: vi.fn(async () => null), persistOperations: vi.fn(async () => undefined),
        tryWithListingSettlementLock: async (_hash: Hex, work: () => Promise<void>) => work(),
        findById: async () => order, transition,
      },
      journal: { dispatchClaim: async () => ({ dispatch: {} }), dispatchResolvedAt: async () => resolvedAt },
      dispatcher: { reconcile },
    });
    const resume = () => (service as unknown as {
      resumePaidOrder(order: StandardOrderRecord): Promise<void>;
    }).resumePaidOrder(order);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(resolvedAt.getTime() + 61 * 60_000);
      await resume();
      expect(transition).not.toHaveBeenCalled();
      expect(currentListing).toHaveBeenCalledWith("7", "formation");
      expect(reconcile).toHaveBeenCalledWith(order, order.listing, canonicalHash({}));
      reconcile.mockRejectedValueOnce(new Error("provider unavailable"));
      await expect(resume()).rejects.toThrow("provider unavailable");
      expect(transition).not.toHaveBeenCalled();
      vi.setSystemTime(resolvedAt.getTime() + 2_592_000_000 - 1);
      await resume();
      expect(transition).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await resume();
      expect(transition).toHaveBeenCalledExactlyOnceWith(order, "PROVIDER_FAILED", "signed_provider_deadline_elapsed");
      transition.mockClear();
      reconcile.mockRejectedValueOnce(new Error("provider unavailable"));
      await resume();
      expect(transition).toHaveBeenCalledExactlyOnceWith(order, "PROVIDER_FAILED", "signed_provider_deadline_elapsed");
      expect(order.listing.deadlinePolicy.fulfillmentSeconds).toBe(3600);
      for (const terminal of ["PROVIDER_FAILED", "FULFILLED"] as const) {
        currentListing.mockClear(); transition.mockClear();
        reconcile.mockResolvedValueOnce({ ...order, state: terminal });
        await resume();
        expect(currentListing).not.toHaveBeenCalled();
        expect(transition).not.toHaveBeenCalled();
      }
    } finally { vi.useRealTimers(); }
  });
});
