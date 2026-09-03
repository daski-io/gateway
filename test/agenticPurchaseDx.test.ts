import { describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyReceiptSignatureEIP712 } from "@x402/extensions/offer-receipt";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Config } from "../src/config.js";
import { mcpJson } from "../src/mcp/util.js";
import { resolveMcpPaymentPayload } from "../src/standardRail/mcp.js";
import {
  paymentRequired,
  paymentRequirements,
  validatePayment,
} from "../src/standardRail/payment.js";
import { asStandardRailError } from "../src/standardRail/errors.js";
import {
  issueReadCapability,
  verifyReadCapability,
} from "../src/standardRail/readCapability.js";
import {
  readSkill,
  skillIndex,
  llmsFull,
} from "../src/standardRail/skills.js";
import { StandardRailService } from "../src/standardRail/service.js";
import {
  walletActionSignRequest,
  verifyWalletAuthorization,
} from "../src/standardRail/walletAuthorization.js";
import {
  createX402OfferReceipt,
  x402PaymentResponse,
} from "../src/standardRail/x402Receipt.js";
import type {
  StandardListing,
  StandardOrderRecord,
  WalletActionAuthorizationV1,
} from "../src/standardRail/types.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => getAddress(`0x${byte.repeat(40)}`) as Hex;
const account = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
const now = 1_788_195_400;

const config = {
  chainId: 84532,
  x402Network: "eip155:84532",
  publicUrl: "https://gateway.example",
  usdc: { name: "USDC", version: "2" },
} as unknown as Config;

type ServiceHarness = StandardRailService & Record<string, unknown>;

function serviceHarness(fields: Record<string, unknown>): ServiceHarness {
  const service = Object.create(StandardRailService.prototype) as ServiceHarness;
  Object.assign(service, fields);
  return service;
}

const listing = {
  providerOwner: address("5"),
  providerAgentWallet: address("6"),
  commitment: {
    payload: {
      canonicalToken: address("a"),
      providerAgentId: "8327",
      providerAuthorityKey: address("1"),
      providerTerminalAttestationKey: address("1"),
      providerPayee: address("2"),
      daskiCommissionReceiver: address("3"),
      outcomeId: "form-entity",
      absoluteResourceUri: "https://gateway.example/outcomes/8327/form-entity",
      bindingProfile: "recipe-bound-v2",
      commissionBps: 500,
      listingEpoch: "1",
    },
  },
  manifest: { payload: { splitterAddress: address("4") } },
  offer: { payload: { skillId: "form-entity" } },
  requestSchema: {
    type: "object",
    additionalProperties: false,
    properties: { entityName: { type: "string" } },
  },
  responseSchema: { type: "object" },
  terms: {
    providerLegalName: "Blue T Group, LLC",
    marketplaceTermsUrl: "https://daski.example/terms",
    marketplacePrivacyUrl: "https://daski.example/privacy",
    providerTermsUrl: "https://provider.example/terms",
    providerPrivacyUrl: "https://provider.example/privacy",
  },
  capacityPolicy: { maxOpenOrders: 25 },
  screeningPolicy: { providerControlledWallets: [] },
  extensionPolicy: {
    requiredExtensions: ["daski-rail-profile", "daski-order-terms", "daski-order-binding"],
    optionalExtensions: ["bazaar", "payment-identifier"],
  },
} as unknown as StandardListing;

const order = {
  listingManifestHash: hash("1"),
  providerOfferHash: hash("2"),
  quoteHash: hash("3"),
  canonicalRequestHash: hash("4"),
  orderNonce: hash("5"),
  intentId: "int_11111111-1111-4111-8111-111111111111",
  grossAmount: "27100000",
  expiresAt: new Date((now + 600) * 1_000),
} as unknown as StandardOrderRecord;

function signReady(validAfter = now - 5) {
  const requirements = paymentRequirements(config, listing, order.grossAmount, 600);
  const challenge = paymentRequired({
    config,
    requirements,
    listing,
    order,
    railProfileHash: hash("9"),
    payerAddress: account.address,
    nowSeconds: now,
  });
  const signRequest = challenge.extensions?.["daski-sign-request"] as {
    eip712: Parameters<typeof account.signTypedData>[0];
    submitAs: { paymentPayload: Record<string, unknown> };
  };
  const authorization = {
    ...(signRequest.eip712.message as Record<string, unknown>),
    validAfter: String(validAfter),
  };
  return { requirements, challenge, signRequest, authorization };
}

async function signedPayment(validAfter = now - 5, echoSignRequest = false) {
  const prepared = signReady(validAfter);
  const signature = await account.signTypedData({
    ...prepared.signRequest.eip712,
    message: {
      ...prepared.signRequest.eip712.message,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(String(
        (prepared.signRequest.eip712.message as Record<string, unknown>).validBefore,
      )),
      value: BigInt(order.grossAmount),
    },
  });
  const template = prepared.signRequest.submitAs.paymentPayload;
  const extensions = {
    ...(template.extensions as Record<string, unknown>),
    ...(echoSignRequest
      ? { "daski-sign-request": prepared.challenge.extensions?.["daski-sign-request"] }
      : {}),
  };
  return {
    prepared,
    payment: {
      ...template,
      payload: { signature, authorization: prepared.authorization },
      extensions,
    },
  };
}

describe("agentic purchase DX contracts", () => {
  it("issues a sub-5KB sign-ready challenge whose exact message validates", async () => {
    const { prepared, payment } = await signedPayment(now - 5, true);
    expect(Buffer.byteLength(JSON.stringify(prepared.challenge))).toBeLessThan(5 * 1024);
    expect(prepared.challenge.extensions?.["payment-identifier"]).toMatchObject({
      info: { required: true, id: order.intentId },
    });
    await expect(validatePayment({
      config,
      listing,
      order,
      requirements: prepared.requirements,
      payment: payment as never,
      railProfileHash: hash("9"),
      validAfterBackstopSeconds: 3600,
      nowSeconds: now,
    })).resolves.toMatchObject({ payer: account.address });
  });

  it("requires the issued payment identifier echo", async () => {
    const { prepared, payment } = await signedPayment();
    const extensions = Object.fromEntries(
      Object.entries(payment.extensions as Record<string, unknown>)
        .filter(([key]) => key !== "payment-identifier"),
    );
    await expect(validatePayment({
      config,
      listing,
      order,
      requirements: prepared.requirements,
      payment: {
        ...payment,
        extensions,
      } as never,
      railProfileHash: hash("9"),
      validAfterBackstopSeconds: 3_600,
      nowSeconds: now,
    })).rejects.toMatchObject({
      code: "EXTENSION_REQUIRED_MISSING",
      field: "payment-identifier",
      requiresNewSignature: true,
    });
  });

  it("submits the sign-ready template through validation and a facilitator settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now * 1_000));
    try {
      const request = { entityName: "Example Labs LLC" };
      const { payment } = await signedPayment();
      const draft = {
        ...order,
        orderId: "ord_11111111-1111-4111-8111-111111111111",
        orderHandle: "unused",
        providerAgentId: "8327",
        outcomeId: "form-entity",
        canonicalRequest: request,
        state: "CHALLENGE_ISSUED",
        payer: null,
        authorizationKey: null,
        paymentPayloadHash: null,
        capabilityEpoch: 0,
        version: 1,
        createdAt: new Date(now * 1_000),
        updatedAt: new Date(now * 1_000),
      } as unknown as StandardOrderRecord;
      const verify = vi.fn(async (presented: PaymentPayload) => {
        expect(presented).toEqual(payment);
        return { isValid: true, payer: account.address };
      });
      const settle = vi.fn(async (presented: PaymentPayload) => {
        expect(presented).toEqual(payment);
        return {
          success: true,
          payer: account.address,
          transaction: hash("8"),
          network: config.x402Network,
        };
      });
      const service = serviceHarness({
        appConfig: config,
        railProfileHash: hash("9"),
        railConfig: {
          manifest: {
            activeRailProfile: {
              payload: { facilitatorProfileHash: hash("e") },
            },
          },
          validAfterBackstopSeconds: 3_600,
          encryptionKey: Buffer.alloc(32, 7),
          quotePrivateKey: hash("6"),
          dispatchPrivateKey: hash("7"),
          receiptPrivateKey: hash("8"),
          lifecyclePrivateKey: hash("9"),
          releasePrivateKey: hash("b"),
          reputationOrderPrivateKey: hash("c"),
          reputationRelayerPrivateKey: hash("d"),
        },
        assertAdmissionOpen: vi.fn(),
        assertRailFence: vi.fn(async () => undefined),
        listing: vi.fn(async () => listing),
        incidents: { record: vi.fn(async () => undefined) },
        store: {
          findByIntentId: vi.fn(async () => ({ handle: "handle-1", order: draft })),
          findByAuthorizationKey: vi.fn(async () => null),
          claimAuthorization: vi.fn(async (claim: {
            authorizationKey: Hex;
            payer: Hex;
            paymentPayloadHash: Hex;
          }) => ({
            ...draft,
            state: "ATTEMPT_OPENED",
            authorizationKey: claim.authorizationKey,
            payer: claim.payer,
            paymentPayloadHash: claim.paymentPayloadHash,
          })),
        },
        driveClaimedOrder: async (
          handle: string,
          claimed: StandardOrderRecord,
          work: (value: StandardOrderRecord) => Promise<StandardOrderRecord>,
        ) => ({ handle, order: await work(claimed), replay: false }),
        settleClaimedOrder: async (args: {
          order: StandardOrderRecord;
          requirements: PaymentRequirements;
          authorization: { payer: Hex };
          payment: PaymentPayload;
        }) => {
          await verify(args.payment);
          const result = await settle(args.payment);
          expect(args.requirements.amount).toBe(order.grossAmount);
          return {
            ...args.order,
            state: "DISPATCHED",
            payer: args.authorization.payer,
            settlementTxHash: result.transaction,
          };
        },
      });

      await expect(service.submitPayment({
        providerAgentId: "8327",
        outcomeId: "form-entity",
        body: request,
        payment: payment as unknown as PaymentPayload,
      })).resolves.toMatchObject({
        handle: "handle-1",
        order: { state: "DISPATCHED", payer: account.address },
        replay: false,
      });
      expect(verify).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, now - 5, now - 600, now - 3599])(
    "accepts validAfter %s",
    async (validAfter) => {
      const { prepared, payment } = await signedPayment(validAfter);
      await expect(validatePayment({
        config,
        listing,
        order,
        requirements: prepared.requirements,
        payment: payment as never,
        railProfileHash: hash("9"),
        validAfterBackstopSeconds: 3600,
        nowSeconds: now,
      })).resolves.toMatchObject({ payer: account.address });
    },
  );

  it.each([now + 5, now - 3601])(
    "rejects out-of-window validAfter %s with a typed client error",
    async (validAfter) => {
      const { prepared, payment } = await signedPayment(validAfter);
      await expect(validatePayment({
        config,
        listing,
        order,
        requirements: prepared.requirements,
        payment: payment as never,
        railProfileHash: hash("9"),
        validAfterBackstopSeconds: 3600,
        nowSeconds: now,
      })).rejects.toMatchObject({
        code: "AUTHORIZATION_WINDOW",
        status: 400,
        field: "payload.authorization.validAfter",
      });
    },
  );

  it("revokes read capabilities by epoch and limits their scopes", () => {
    const key = Buffer.alloc(32, 7);
    const issued = issueReadCapability({
      key,
      orderId: "ord_test",
      payer: account.address,
      audience: "https://gateway.example",
      capabilityEpoch: 4,
      ttlSeconds: 1800,
      nowSeconds: now,
    });
    expect(verifyReadCapability({
      key,
      token: issued.readCapability,
      orderId: "ord_test",
      payer: account.address,
      audience: "https://gateway.example",
      capabilityEpoch: 4,
      requiredScope: "artifact",
      nowSeconds: now + 10,
    })).toMatchObject({ epoch: 4, scope: ["status", "artifact"] });
    expect(() => verifyReadCapability({
      key,
      token: issued.readCapability,
      orderId: "ord_test",
      payer: account.address,
      audience: "https://gateway.example",
      capabilityEpoch: 5,
      requiredScope: "status",
      nowSeconds: now + 10,
    })).toThrow();
  });

  it("round-trips the complete wallet-action sign request", async () => {
    const message: WalletActionAuthorizationV1 = {
      payer: account.address.toLowerCase() as Hex,
      providerAgentId: "0",
      serviceId: hash("0"),
      providerControlProfileHash: hash("0"),
      servicingAdmissionHash: hash("0"),
      actionCatalogHash: hash("0"),
      actionCatalogSchemaHash: hash("0"),
      actionDefinitionHash: hash("0"),
      actionCatalogEpoch: 0,
      actionHash: hash("1"),
      methodHash: hash("2"),
      absoluteResourceUriHash: hash("3"),
      requestHash: hash("4"),
      audienceHash: hash("5"),
      nonce: hash("6"),
      issuedAt: now,
      validBefore: now + 300,
    };
    const signRequest = walletActionSignRequest(message, config.chainId);
    const signature = await account.signTypedData({
      ...signRequest,
      message: {
        ...message,
        providerAgentId: 0n,
        actionCatalogEpoch: 0n,
        issuedAt: BigInt(now),
        validBefore: BigInt(now + 300),
      },
    });
    await expect(verifyWalletAuthorization({
      authorization: { message, signature },
      expected: message,
      chainId: config.chainId,
      now,
    })).resolves.toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("serves checksum-stable skills and an exact full concatenation", async () => {
    const index = await skillIndex("https://gateway.example", "test");
    const setup = await readSkill("setup");
    expect(index.skills.find((item) => item.name === "setup")).toMatchObject({
      sha256: setup.sha256,
      bytes: Buffer.byteLength(setup.content),
    });
    const names = ["setup", "buy", "orders", "wallets", "recipe", "daski"] as const;
    const expected = (await Promise.all(names.map((name) => readSkill(name))))
      .map((skill) => skill.content.trimEnd()).join("\n\n") + "\n";
    expect(await llmsFull()).toBe(expected);
  });

  it("places a Foundation-shaped receipt in the x402 settlement extension", async () => {
    const receipt = await createX402OfferReceipt({
      privateKey: `0x${"33".repeat(32)}` as Hex,
      network: config.x402Network,
      resourceUrl: listing.commitment.payload.absoluteResourceUri,
      payer: account.address,
      issuedAt: now,
      transaction: hash("8"),
    });
    const verified = await verifyReceiptSignatureEIP712(receipt);
    expect(verified.payload).toMatchObject({
      payer: account.address,
      issuedAt: now,
      transaction: hash("8"),
    });
    expect(x402PaymentResponse({
      receipt,
      network: config.x402Network,
      payer: account.address,
      transaction: hash("8"),
    })).toMatchObject({
      success: true,
      extensions: { "offer-receipt": { info: { receipt } } },
    });
  });

  it("carries every MCP payload in structuredContent and as serialized JSON text", () => {
    const payment = { x402Version: 2 };
    expect(resolveMcpPaymentPayload(payment, undefined)).toBe(payment);
    expect(resolveMcpPaymentPayload(undefined, payment)).toBe(payment);
    expect(resolveMcpPaymentPayload(payment, { x402Version: 1 })).toBe(payment);

    // MCP 2025-06-18: a tool returning structured content SHOULD also return
    // the serialized JSON in a text block. A one-line summary here (v0.28.0 to
    // v0.30.0) left text-only clients blind, @daski/pay 0.1.0 among them.
    const ordinary = mcpJson({ ok: true });
    expect(ordinary.content[0]).toEqual({ type: "text", text: JSON.stringify({ ok: true }) });
    expect(ordinary.structuredContent).toEqual({ ok: true });
    const required = mcpJson(payment, { "x402/payment-required": payment });
    expect(required.content[0]).toEqual({ type: "text", text: JSON.stringify(payment) });
    expect(required._meta).toEqual({ "x402/payment-required": payment });
  });
});

describe("legacy standard-rail error bridge", () => {
  const cases = [
    ["OUTCOME_NOT_FOUND", "OUTCOME_NOT_FOUND"],
    ["LISTING_SUPERSEDED", "LISTING_SUPERSEDED"],
    ["PROVIDER_QUOTE_REJECTED", "PROVIDER_QUOTE_REJECTED"],
    ["PROVIDER_QUOTE_UNAVAILABLE", "PROVIDER_QUOTE_UNAVAILABLE"],
    ["PROVIDER_QUOTE_INVALID", "PROVIDER_QUOTE_UNAVAILABLE"],
    ["PROVIDER_QUOTE_SIGNATURE_INVALID", "PROVIDER_QUOTE_UNAVAILABLE"],
    ["PROVIDER_QUOTE_NOT_RELEASABLE", "PROVIDER_QUOTE_UNAVAILABLE"],
    ["OUTCOME_OFFER_EXPIRED", "CHALLENGE_EXPIRED"],
    ["Unsupported payment version or extension", "PAYMENT_VERSION_UNSUPPORTED"],
    ["Payment payload has an open shape", "PAYLOAD_SHAPE_INVALID"],
    ["Unsupported Exact-EVM payload field", "PAYLOAD_SHAPE_INVALID"],
    ["Missing EIP-3009 authorization", "PAYLOAD_SHAPE_INVALID"],
    ["EIP-3009 authorization has an open shape", "AUTHORIZATION_SHAPE_INVALID"],
    ["EIP-3009 authorization does not match the challenge", "AUTHORIZATION_MISMATCH"],
    ["Stock profile requires validAfter=0", "AUTHORIZATION_WINDOW"],
    ["Recipe authorization lower bound is outside the allowed clock window", "AUTHORIZATION_WINDOW"],
    ["Known self-purchase is forbidden", "SELF_PURCHASE_FORBIDDEN"],
    ["Known operational-wallet self-purchase is forbidden", "SELF_PURCHASE_FORBIDDEN"],
    ["Recipe nonce mismatch", "NONCE_RECIPE_MISMATCH"],
    ["High-s signatures are forbidden", "SIGNATURE_INVALID"],
    ["EIP-3009 signature is invalid", "SIGNATURE_INVALID"],
    ["Changed authorization replay rejected", "PAYMENT_IDENTIFIER_CONFLICT"],
    ["ACTION_AUTHORIZATION_EXPIRED", "WALLET_AUTHORIZATION_INVALID"],
    ["ACTION_AUTHORIZATION_BINDING_INVALID", "WALLET_AUTHORIZATION_INVALID"],
    ["ACTION_AUTHORIZATION_INVALID", "WALLET_AUTHORIZATION_INVALID"],
    ["ACTION_CHALLENGE_INVALID_OR_REPLAYED", "WALLET_AUTHORIZATION_INVALID"],
    ["wallet authorization denied", "WALLET_AUTHORIZATION_INVALID"],
  ] as const;

  it.each(cases)("maps %s exactly to %s", (legacy, code) => {
    expect(asStandardRailError(new Error(legacy))).toMatchObject({ code });
  });
});
