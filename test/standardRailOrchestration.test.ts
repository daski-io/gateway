import { describe, expect, it, vi } from "vitest";
import { keccak256, stringToHex, type Hex } from "viem";
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
    } as unknown as PaymentPayload;
    const order = {
      orderId: "order-1",
      providerAgentId: "7",
      outcomeId: "outcome",
      canonicalRequest: body,
      paymentPayloadHash: canonicalHash(payment),
    } as StandardOrderRecord;
    const existing = { handle: "handle-1", order };
    const service = harness({
      appConfig: { chainId: 84532 },
      assertAdmissionOpen: vi.fn(),
      assertRailFence: vi.fn(async () => undefined),
      store: { findByAuthorizationKey: vi.fn(async () => existing) },
      incidents: { record: vi.fn() },
    });

    await expect(service.submitPayment({
      providerAgentId: "7",
      outcomeId: "outcome",
      body,
      payment,
    })).resolves.toEqual({ ...existing, replay: true });
  });

  it("accepts a wallet-signed status action and returns its receipt", async () => {
    const account = privateKeyToAccount(
      `0x${"11".repeat(32)}` as Hex,
    );
    const now = Math.floor(Date.now() / 1_000);
    const request = {};
    const action = "status" as const;
    const order = {
      orderId: "order-1",
      payer: account.address,
      state: "FULFILLED",
    } as StandardOrderRecord;
    const absoluteResourceUri =
      "https://gateway.example/orders/handle-1/actions/status";
    const authorization = {
      orderId: order.orderId,
      action,
      method: "POST" as const,
      absoluteResourceUri,
      requestHash: canonicalHash(request),
      nonce: hash("4"),
      issuedAt: now,
      validBefore: now + 120,
    };
    const signature = await account.signTypedData({
      domain: {
        name: "DaskiStandardOrder",
        version: "1",
        chainId: 84532,
      },
      types: {
        OrderActionAuthorizationV1: [
          { name: "orderIdHash", type: "bytes32" },
          { name: "actionHash", type: "bytes32" },
          { name: "methodHash", type: "bytes32" },
          { name: "absoluteResourceUriHash", type: "bytes32" },
          { name: "requestHash", type: "bytes32" },
          { name: "audienceHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint64" },
          { name: "validBefore", type: "uint64" },
        ],
      },
      primaryType: "OrderActionAuthorizationV1",
      message: {
        orderIdHash: keccak256(stringToHex(order.orderId)),
        actionHash: keccak256(stringToHex(action)),
        methodHash: keccak256(stringToHex("POST")),
        absoluteResourceUriHash: keccak256(stringToHex(absoluteResourceUri)),
        requestHash: authorization.requestHash,
        audienceHash: keccak256(stringToHex("gateway.example")),
        nonce: authorization.nonce,
        issuedAt: BigInt(authorization.issuedAt),
        validBefore: BigInt(authorization.validBefore),
      },
    });
    const receipt = { artifactType: "StandardRailReceiptV2" };
    const consumeActionChallenge = vi.fn(async () => undefined);
    const service = harness({
      appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
      railConfig: { gatewayAudience: "gateway.example" },
      assertRailFence: vi.fn(async () => undefined),
      store: { findByHandle: vi.fn(async () => order) },
      journal: { consumeActionChallenge },
      incidents: { record: vi.fn() },
      signedReceipt: vi.fn(async () => receipt),
    });

    await expect(service.performAction({
      handle: "handle-1",
      action,
      request,
      authorization: { ...authorization, signature },
    })).resolves.toEqual({ orderHandle: "handle-1", state: "FULFILLED", receipt });
    expect(consumeActionChallenge).toHaveBeenCalledOnce();
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
        withListingSettlementLock: async (
          _listingHash: Hex,
          action: () => Promise<void>,
        ) => action(),
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
