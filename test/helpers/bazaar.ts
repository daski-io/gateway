import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { canonicalJsonStringify } from "../../src/auth/envelope.js";
import {
  computeListingTermsHash,
} from "../../src/bazaar/listingManifest.js";
import {
  computeListingCommitment,
  LISTING_OFFER_V1_TYPES,
  listingOfferDomain,
} from "../../src/bazaar/offer.js";
import { PAY_TO_CONTROL_TYPES } from "../../src/bazaar/payToControl.js";
import type {
  BazaarCompatibilityWiring,
  BazaarDispatchInput,
  BazaarFacilitatorClient,
  BazaarFulfillmentService,
  BazaarLifecycleDispatchInput,
  BazaarProviderActionSigningBroker,
  BazaarListing,
  ListingOfferV1,
} from "../../src/bazaar/types.js";

export const TEST_NOW = new Date("2026-08-10T18:00:00.000Z");
export const PROVIDER_KEY =
  `0x${"22".repeat(32)}` as Hex;
export const CHALLENGE_MAC_SECRET = Buffer.from("33".repeat(32), "hex");
export const PROVIDER_ACTION_KEY =
  `0x${"44".repeat(32)}` as Hex;
export const SECOND_PAY_TO_KEY = `0x${"55".repeat(32)}` as Hex;
export const TEST_TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Hex;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export interface BazaarHarness {
  wiring: BazaarCompatibilityWiring;
  providerAccount: PrivateKeyAccount;
  facilitator: FakeFacilitator;
  fulfillment: FakeFulfillment;
}

export async function createBazaarHarness(): Promise<BazaarHarness> {
  const providerAccount = privateKeyToAccount(PROVIDER_KEY);
  const listing = await createListing(providerAccount);
  const facilitator = new FakeFacilitator();
  const fulfillment = new FakeFulfillment();
  const wiring: BazaarCompatibilityWiring = {
    listings: [listing],
    approvedTermsOrigins: ["https://gateway.test"],
    facilitator,
    evidenceVerifier: {
      verify: async (input) => ({
        ...input,
        finalized: true,
        authorizationUsedEventCount: 1,
        matchingTransferEventCount: 1,
      }),
    },
    payerProfileVerifier: {
      verifyBeforeSettlement: async () => ({ profile: "eoa" }),
    },
    fulfillment,
    challengeMac: {
      current: { epoch: "test-2026-08", secret: CHALLENGE_MAC_SECRET },
    },
    settlementCapacity: {
      maxGlobalConcurrent: 16,
      maxPerListingConcurrent: 8,
      maxPerPayerConcurrent: 4,
      maxGlobalPerMinute: 120,
      maxPerListingPerMinute: 60,
      maxPerPayerPerMinute: 30,
    },
    providerActionSigningBroker: accountLifecycleBroker(
      privateKeyToAccount(PROVIDER_ACTION_KEY),
    ),
    now: () => new Date(TEST_NOW),
  };
  return { wiring, providerAccount, facilitator, fulfillment };
}

export async function createListing(
  provider: PrivateKeyAccount,
  options: { payTo?: PrivateKeyAccount; slug?: string } = {},
): Promise<BazaarListing> {
  const payTo = options.payTo ?? provider;
  const slug = options.slug ?? "test-report";
  const resourceUrl = `https://gateway.test/x402/v1/outcomes/${slug}`;
  const requestSchema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const responseSchema = {
    type: "object",
    properties: {
      orderHandle: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
      lifecycle: {
        type: "object",
        properties: {
          challengeUrl: { type: "string" },
          redeemUrl: { type: "string" },
        },
        required: ["challengeUrl", "redeemUrl"],
        additionalProperties: false,
      },
    },
    required: ["orderHandle", "lifecycle"],
    additionalProperties: false,
  };
  const hashJson = (value: Record<string, unknown>) =>
    keccak256(toBytes(canonicalJsonStringify(value)));
  const termsDocument = Buffer.from(
    `# Test Provider Terms v1\n\nFixed test-report terms for ${slug}.\n`,
    "utf8",
  );
  const terms = {
    description: "Purchase one fixed test report from the named provider through Daski.",
    sellerName: "Test Provider",
    expectedDelivery: "Within five minutes",
    refundTerms: "Provider reviews failed fulfillment and issues any refund.",
    termsUrl: `https://gateway.test/terms/v1/${slug}.md`,
    termsDocumentHash: keccak256(termsDocument),
  };
  const now = BigInt(Math.floor(TEST_NOW.getTime() / 1000));
  const message: ListingOfferV1 = {
    chainId: 84532n,
    listingEpoch: keccak256(toBytes(`${slug}-epoch-1`)),
    listingCommitment: ZERO_BYTES32,
    providerAgentId: 701n,
    offerSigner: provider.address,
    providerPayee: payTo.address,
    outcomeId: keccak256(toBytes(slug)),
    methodHash: keccak256(toBytes("POST")),
    resourceHash: keccak256(toBytes(resourceUrl)),
    requestSchemaHash: hashJson(requestSchema),
    responseSchemaHash: hashJson(responseSchema),
    requestBindingModeHash: keccak256(toBytes("stock-fixed-v1")),
    routeModeHash: keccak256(toBytes("test-provider-direct-v1")),
    token: TEST_TOKEN,
    grossAmount: 10_000n,
    payTo: payTo.address,
    paymentMaxTimeoutSeconds: 300n,
    daskiCommissionReceiver: "0x0000000000000000000000000000000000000000",
    commissionBps: 0n,
    splitterCodeHash: ZERO_BYTES32,
    termsHash: computeListingTermsHash(terms),
    policyVersion: keccak256(toBytes("test-policy-1")),
    offerId: keccak256(toBytes(`${slug}-offer-1`)),
    issuedAt: now - 60n,
    validBefore: now + 3_600n,
  };
  message.listingCommitment = computeListingCommitment(message);
  const payToControlProof = {
    validBefore: message.validBefore,
    signature: await payTo.signTypedData({
      domain: {
        name: "Daski Bazaar PayTo Control",
        version: "1",
        chainId: message.chainId,
        verifyingContract: message.payTo,
      },
      types: PAY_TO_CONTROL_TYPES,
      primaryType: "DaskiBazaarPayToControl",
      message: {
        providerAgentId: message.providerAgentId,
        listingEpoch: message.listingEpoch,
        listingCommitment: message.listingCommitment,
        payTo: message.payTo,
        validBefore: message.validBefore,
      },
    }),
  };
  const signature = await provider.signTypedData({
    domain: listingOfferDomain(message),
    types: LISTING_OFFER_V1_TYPES,
    primaryType: "ListingOfferV1",
    message,
  });
  return {
    routePath: `/x402/v1/outcomes/${slug}`,
    resourceUrl,
    ...terms,
    termsDocumentMediaType: "text/markdown; charset=utf-8" as const,
    termsDocumentBase64: termsDocument.toString("base64"),
    requestSchema,
    responseSchema,
    assetName: "USDC",
    assetVersion: "2",
    listingEpoch: message.listingEpoch,
    listingCommitment: message.listingCommitment,
    termsHash: message.termsHash,
    policyVersion: message.policyVersion,
    payToControlProof,
    offer: { message, signature },
  };
}

export async function createPaymentPayload(input: {
  paymentRequired: PaymentRequired;
  buyer: PrivateKeyAccount;
  nonce: Hex;
  validAfter?: bigint;
  validBefore?: bigint;
}): Promise<PaymentPayload> {
  const requirements = input.paymentRequired.accepts[0]!;
  const now = BigInt(Math.floor(TEST_NOW.getTime() / 1000));
  const authorization = {
    from: input.buyer.address,
    to: requirements.payTo as Hex,
    value: BigInt(requirements.amount),
    validAfter: input.validAfter ?? now - 1n,
    validBefore: input.validBefore ?? now + 240n,
    nonce: input.nonce,
  };
  const signature = await input.buyer.signTypedData({
    domain: {
      name: requirements.extra.name as string,
      version: requirements.extra.version as string,
      chainId: 84532n,
      verifyingContract: requirements.asset as Hex,
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
    message: authorization,
  });
  return {
    x402Version: 2,
    resource: input.paymentRequired.resource,
    accepted: requirements,
    extensions: input.paymentRequired.extensions,
    payload: {
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
      signature,
    },
  };
}

export class FakeFacilitator implements BazaarFacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  verifyError = false;
  settleError = false;
  settleExtra: Record<string, unknown> | undefined;
  settleGate: Promise<void> | null = null;

  async verify(payload: PaymentPayload) {
    this.verifyCalls += 1;
    if (this.verifyError) throw new Error("ambiguous verify");
    return {
      response: { isValid: true, payer: payer(payload) },
      extensionResponses: extensionResponse("success"),
    };
  }

  async settle(payload: PaymentPayload) {
    this.settleCalls += 1;
    await this.settleGate;
    if (this.settleError) throw new Error("ambiguous settle");
    const authorization = payload.payload.authorization as Record<string, string>;
    return {
      response: {
        success: true,
        payer: payer(payload),
        transaction: authorization.nonce,
        network: "eip155:84532" as const,
        amount: payload.accepted.amount,
        extra: this.settleExtra,
      },
      extensionResponses: extensionResponse("processing"),
    };
  }
}

export class FakeFulfillment implements BazaarFulfillmentService {
  dispatchCalls = 0;
  lifecycleCalls: BazaarLifecycleDispatchInput[] = [];

  async dispatch(input: BazaarDispatchInput) {
    this.dispatchCalls += 1;
    return { taskId: `task-${input.orderRecordId.slice(-12)}` };
  }

  async performLifecycleAction(input: BazaarLifecycleDispatchInput) {
    this.lifecycleCalls.push(input);
    return { state: "working", action: input.action };
  }
}

export function accountLifecycleBroker(
  account: PrivateKeyAccount,
): BazaarProviderActionSigningBroker {
  return {
    address: account.address,
    signLifecycleAction: (input) => account.signTypedData({
      domain: {
        name: "Daski Bazaar Lifecycle Action",
        version: "1",
        chainId: BigInt(input.chainId),
        verifyingContract: input.payTo,
      },
      types: {
        DaskiBazaarLifecycleAction: [
          { name: "orderRecordId", type: "bytes32" },
          { name: "taskIdHash", type: "bytes32" },
          { name: "providerAgentId", type: "uint256" },
          { name: "actionHash", type: "bytes32" },
          { name: "requestHash", type: "bytes32" },
          { name: "buyerAuthorizationDigest", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
        ],
      },
      primaryType: "DaskiBazaarLifecycleAction",
      message: {
        ...input.message,
        providerAgentId: BigInt(input.message.providerAgentId),
        issuedAt: BigInt(input.message.issuedAt),
        expiresAt: BigInt(input.message.expiresAt),
      },
    }),
  };
}

function payer(payload: PaymentPayload): Hex {
  return (payload.payload.authorization as Record<string, Hex>).from;
}

function extensionResponse(status: "success" | "processing"): string {
  return Buffer.from(JSON.stringify({ bazaar: { status } }), "utf8").toString("base64");
}
