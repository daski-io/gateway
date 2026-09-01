import { describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload } from "@x402/core/types";
import { canonicalHash } from "../src/standardRail/canonical.js";
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
      store: { findOpenDraft, createDraft },
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
      store: { findByIntentId: vi.fn(async () => existing) },
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
          walletChallengesOutstandingPerClient: 100,
          walletChallengesOutstandingGlobal: 1_000,
        },
      },
      assertRailFence: vi.fn(async () => undefined),
      store: { findByHandle: vi.fn(async () => order) },
      journal: { issueActionChallenge, consumeActionChallenge },
      incidents: { record: vi.fn() },
      signedReceipt: vi.fn(async () => receipt),
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
    })).resolves.toEqual({ orderHandle: "handle-1", state: "FULFILLED", receipt });

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
    })).resolves.toEqual({ orderHandle: "handle-1", state: "FULFILLED", receipt });
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
      store: {
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
