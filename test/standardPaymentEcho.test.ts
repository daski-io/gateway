import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload } from "@x402/core/types";
import type { Config } from "../src/config.js";
import { recipeNonceV2 } from "../src/standardRail/canonical.js";
import {
  paymentRequired,
  paymentRequirements,
  validatePayment,
} from "../src/standardRail/payment.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => getAddress(`0x${byte.repeat(40)}`) as Hex;

const RAIL_PROFILE_HASH = hash("9");
const GROSS_AMOUNT = "46800000";

const config = {
  chainId: 84532,
  x402Network: "eip155:84532",
  usdc: { name: "USDC", version: "2" },
} as unknown as Config;

const listing = {
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
  requestSchema: { type: "object" },
  responseSchema: { type: "object" },
  terms: {
    providerLegalName: "Example Provider LLC",
    marketplaceTermsUrl: "https://daski.example/terms",
    marketplacePrivacyUrl: "https://daski.example/privacy",
    providerTermsUrl: "https://provider.example/terms",
    providerPrivacyUrl: "https://provider.example/privacy",
  },
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
  grossAmount: GROSS_AMOUNT,
  expiresAt: new Date(Date.now() + 120_000),
} as unknown as StandardOrderRecord;

async function signedPayment(
  extensions: (issued: Record<string, unknown>) => Record<string, unknown>,
): Promise<PaymentPayload> {
  const account = privateKeyToAccount(`0x${"22".repeat(32)}` as Hex);
  const requirements = paymentRequirements(config, listing, GROSS_AMOUNT, 120);
  const issued = paymentRequired({
    requirements, listing, order, railProfileHash: RAIL_PROFILE_HASH,
  });
  const now = Math.floor(Date.now() / 1_000);
  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value: GROSS_AMOUNT,
    validAfter: String(now - 5),
    validBefore: String(Math.floor(order.expiresAt.getTime() / 1_000)),
    nonce: recipeNonceV2({
      chainId: config.chainId,
      canonicalToken: getAddress(requirements.asset),
      payer: account.address,
      splitter: getAddress(requirements.payTo),
      grossAmount: BigInt(GROSS_AMOUNT),
      runtimeCommitmentHash: order.listingManifestHash,
      providerIntentHash: order.providerOfferHash,
      quoteHash: order.quoteHash,
      canonicalRequestHash: order.canonicalRequestHash,
      orderNonce: order.orderNonce,
    }),
  };
  const signature = await account.signTypedData({
    domain: {
      name: config.usdc.name,
      version: config.usdc.version,
      chainId: config.chainId,
      verifyingContract: getAddress(requirements.asset),
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: getAddress(requirements.payTo),
      value: BigInt(GROSS_AMOUNT),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return {
    x402Version: 2,
    resource: issued.resource,
    accepted: requirements,
    payload: { signature, authorization },
    extensions: extensions(issued.extensions as Record<string, unknown>),
  } as unknown as PaymentPayload;
}

function validated(payment: PaymentPayload) {
  return validatePayment({
    config,
    listing,
    order,
    requirements: paymentRequirements(config, listing, GROSS_AMOUNT, 120),
    payment,
    railProfileHash: RAIL_PROFILE_HASH,
  });
}

describe("standard payment extension echo", () => {
  it("accepts a payment built from the compact header, without the bazaar declaration", async () => {
    const payment = await signedPayment((issued) =>
      Object.fromEntries(Object.entries(issued).filter(([key]) => key !== "bazaar")));
    const result = await validated(payment);
    expect(result.payer).toBe(privateKeyToAccount(`0x${"22".repeat(32)}` as Hex).address);
  });

  it("accepts a payment echoing the complete challenge, bazaar included", async () => {
    const payment = await signedPayment((issued) => ({ ...issued }));
    await expect(validated(payment)).resolves.toMatchObject({
      payer: privateKeyToAccount(`0x${"22".repeat(32)}` as Hex).address,
    });
  });

  it("rejects a tampered bazaar declaration", async () => {
    const payment = await signedPayment((issued) => ({
      ...issued,
      bazaar: { info: { seller: "Someone Else" } },
    }));
    await expect(validated(payment)).rejects.toThrow(
      "Payment extension bazaar differs from the issued challenge",
    );
  });

  it("still requires the order-binding extensions", async () => {
    const payment = await signedPayment((issued) =>
      Object.fromEntries(Object.entries(issued).filter(([key]) => key !== "daski-order-binding")));
    await expect(validated(payment)).rejects.toThrow(
      "Payment extension daski-order-binding is required",
    );
  });
});
