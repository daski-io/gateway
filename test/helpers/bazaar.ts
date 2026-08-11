import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
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
import { FULFILLMENT_SIGNER_CONTROL_TYPES } from
  "../../src/bazaar/fulfillmentSignerControl.js";
import {
  BAZAAR_FULFILLMENT_ATTESTATION_TYPES,
  computeBazaarFulfillmentEvidenceId,
} from "../../src/bazaar/fulfillmentAttestation.js";
import { BAZAAR_REFUND_INSTRUCTION_TYPES } from "../../src/bazaar/refundInstruction.js";
import { computeBazaarRefundPolicyVersion } from "../../src/bazaar/refundPolicy.js";
import { computeBazaarRuntimeManifestIdentity } from
  "../../src/bazaar/runtimeManifest.js";
import { bazaarRuntimeManifestApprovalTypedData } from
  "../../src/bazaar/runtimeManifestApproval.js";
import type {
  BazaarCompatibilityWiring,
  BazaarDispatchInput,
  BazaarDispatchResult,
  BazaarFacilitatorClient,
  BazaarFulfillmentService,
  BazaarFulfillmentObserver,
  BazaarFulfillmentObservationInput,
  BazaarFulfillmentOutcome,
  BazaarLifecycleDispatchInput,
  BazaarSettlementObservationInput,
  BazaarSettlementObservationResult,
  BazaarProviderActionSigningBroker,
  BazaarRefundInstructionSigningBroker,
  BazaarRefundEvidenceInput,
  BazaarRefundRequestService,
  BazaarRefundRiskPolicy,
  BazaarListing,
  ListingOfferV1,
  BazaarRuntimeAdapterIdentity,
  BazaarRuntimeManifestTrust,
} from "../../src/bazaar/types.js";

export const TEST_NOW = new Date("2026-08-10T18:00:00.000Z");
export const PROVIDER_KEY =
  `0x${"22".repeat(32)}` as Hex;
export const CHALLENGE_MAC_SECRET = Buffer.from("33".repeat(32), "hex");
export const PROVIDER_ACTION_KEY =
  `0x${"44".repeat(32)}` as Hex;
export const SECOND_PAY_TO_KEY = `0x${"55".repeat(32)}` as Hex;
export const REFUND_SIGNING_KEY = `0x${"66".repeat(32)}` as Hex;
export const REFUND_WALLET_KEY = `0x${"77".repeat(32)}` as Hex;
export const FULFILLMENT_SIGNING_KEY = `0x${"aa".repeat(32)}` as Hex;
export const RUNTIME_MANIFEST_AUTHORITY_KEY = `0x${"bb".repeat(32)}` as Hex;
export const TEST_RUNTIME_DEPLOYMENT_ID = keccak256(toBytes("daski-test-deployment"));
export const TEST_LIFECYCLE_RETENTION_SECONDS = 365 * 24 * 60 * 60;
export const TEST_TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Hex;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const REFUND_EVIDENCE_HASH = `0x${"88".repeat(32)}` as Hex;
const REFUND_BLOCK_HASH = `0x${"99".repeat(32)}` as Hex;

export interface BazaarHarness {
  wiring: BazaarCompatibilityWiring;
  providerAccount: PrivateKeyAccount;
  fulfillmentSignerAccount: PrivateKeyAccount;
  facilitator: FakeFacilitator;
  fulfillment: FakeFulfillment;
  fulfillmentObserver: FakeFulfillmentObserver;
  settlementObserver: FakeSettlementObserver;
  refundService: FakeRefundService;
  refundEvidence: FakeRefundEvidenceVerifier;
  runtimeManifestTrust: BazaarRuntimeManifestTrust;
  runtimeManifestAuthority: PrivateKeyAccount;
}

export async function createBazaarHarness(options: {
  refundPolicyOverrides?: Partial<BazaarRefundRiskPolicy>;
} = {}): Promise<BazaarHarness> {
  const providerAccount = privateKeyToAccount(PROVIDER_KEY);
  const fulfillmentSignerAccount = privateKeyToAccount(FULFILLMENT_SIGNING_KEY);
  const refundPolicy = createTestRefundPolicy(options.refundPolicyOverrides);
  const listing = await createListing(providerAccount, {
    refundPolicy,
    fulfillmentSigner: fulfillmentSignerAccount,
  });
  const facilitator = new FakeFacilitator();
  const fulfillment = new FakeFulfillment();
  const settlementObserver = new FakeSettlementObserver();
  const fulfillmentObserver = new FakeFulfillmentObserver(
    fulfillmentSignerAccount,
  );
  const refundService = new FakeRefundService();
  const refundEvidence = new FakeRefundEvidenceVerifier();
  const runtimeManifestAuthority = privateKeyToAccount(
    RUNTIME_MANIFEST_AUTHORITY_KEY,
  );
  const runtimeManifestTrust: BazaarRuntimeManifestTrust = {
    authority: runtimeManifestAuthority.address,
    deploymentId: TEST_RUNTIME_DEPLOYMENT_ID,
    chainId: 84532n,
  };
  const wiring: BazaarCompatibilityWiring = {
    runtimeManifestEpoch: 1n,
    runtimeManifestApproval: {
      issuedAt: BigInt(Math.floor(TEST_NOW.getTime() / 1_000)) - 60n,
      validBefore: BigInt(Math.floor(TEST_NOW.getTime() / 1_000)) + 3_600n,
      signature: `0x${"11".repeat(65)}`,
    },
    runtimeIdentity: testAdapterIdentity("gateway-runtime"),
    providerAuthorityIdentity: testAdapterIdentity("provider-authority"),
    listings: [listing],
    recoveryListings: [],
    retiredLifecycleCommitments: [],
    adapterCallTimeoutMs: 1_000,
    publicOrigin: "https://gateway.test",
    approvedTermsOrigins: ["https://gateway.test"],
    facilitator,
    evidenceVerifier: {
      identity: testAdapterIdentity("settlement-evidence"),
      verify: async (input) => ({
        ...input,
        finalized: true,
        authorizationUsedEventCount: 1,
        matchingTransferEventCount: 1,
      }),
    },
    settlementObserver,
    settlementObservationPolicy: {
      finalityWindowSeconds: 60,
      retryDelaySeconds: 30,
    },
    fulfillmentObserver,
    fulfillmentObservationPolicy: { retryDelaySeconds: 30 },
    payerProfileVerifier: {
      identity: testAdapterIdentity("payer-profile"),
      verifyBeforeSettlement: async (input) => ({ ...input, profile: "eoa" }),
    },
    fulfillment,
    challengeMac: {
      current: { epoch: "test-2026-08", secret: CHALLENGE_MAC_SECRET },
    },
    settlementCapacity: {
      maxGlobalConcurrent: 16,
      maxPerProviderConcurrent: 12,
      maxPerListingConcurrent: 8,
      maxPerPayerConcurrent: 4,
      maxGlobalPerMinute: 120,
      maxPerProviderPerMinute: 90,
      maxPerListingPerMinute: 60,
      maxPerPayerPerMinute: 30,
    },
    refundRiskPolicies: {
      "701": refundPolicy,
    },
    refundWorkerPolicy: {
      instructionTtlSeconds: 60,
      retryDelaySeconds: 30,
    },
    refundInstructionSigningBroker: accountRefundBroker(
      privateKeyToAccount(REFUND_SIGNING_KEY),
    ),
    refundRequestService: refundService,
    refundEvidenceVerifier: refundEvidence,
    providerActionSigningBroker: accountLifecycleBroker(
      privateKeyToAccount(PROVIDER_ACTION_KEY),
    ),
  };
  await approveBazaarRuntimeWiring(
    wiring,
    runtimeManifestTrust,
    runtimeManifestAuthority,
    TEST_LIFECYCLE_RETENTION_SECONDS,
    TEST_NOW,
  );
  return {
    wiring,
    providerAccount,
    fulfillmentSignerAccount,
    facilitator,
    fulfillment,
    fulfillmentObserver,
    settlementObserver,
    refundService,
    refundEvidence,
    runtimeManifestTrust,
    runtimeManifestAuthority,
  };
}

export function testAdapterIdentity(role: string): BazaarRuntimeAdapterIdentity {
  return {
    artifactHash: keccak256(toBytes(`daski-test-adapter:${role}:artifact`)),
    configurationHash: keccak256(toBytes(`daski-test-adapter:${role}:config`)),
    authorityEpoch: "test-v1",
  };
}

export async function approveBazaarRuntimeWiring(
  wiring: BazaarCompatibilityWiring,
  trust: BazaarRuntimeManifestTrust,
  authority: PrivateKeyAccount,
  lifecycleDomainRetentionSeconds = TEST_LIFECYCLE_RETENTION_SECONDS,
  approvalTime = new Date(),
): Promise<void> {
  const now = BigInt(Math.floor(approvalTime.getTime() / 1_000));
  wiring.runtimeManifestApproval.issuedAt = now - 60n;
  wiring.runtimeManifestApproval.validBefore = now + 3_600n;
  const identity = computeBazaarRuntimeManifestIdentity(
    wiring,
    lifecycleDomainRetentionSeconds,
  );
  wiring.runtimeManifestApproval.signature = await authority.signTypedData(
    bazaarRuntimeManifestApprovalTypedData({
      identity,
      approval: wiring.runtimeManifestApproval,
      trust,
    }),
  );
}

export async function createListing(
  provider: PrivateKeyAccount,
  options: {
    payTo?: PrivateKeyAccount;
    slug?: string;
    refundPolicy?: BazaarRefundRiskPolicy;
    fulfillmentSigner?: PrivateKeyAccount;
  } = {},
): Promise<BazaarListing> {
  const payTo = options.payTo ?? provider;
  const fulfillmentSigner = options.fulfillmentSigner ??
    privateKeyToAccount(FULFILLMENT_SIGNING_KEY);
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
    fulfillmentSigner: fulfillmentSigner.address,
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
    policyVersion: computeBazaarRefundPolicyVersion(
      701n,
      options.refundPolicy ?? createTestRefundPolicy(),
    ),
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
  const fulfillmentSignerControlProof = {
    validBefore: message.validBefore,
    signature: await fulfillmentSigner.signTypedData({
      domain: {
        name: "Daski Bazaar Fulfillment Signer Control",
        version: "1",
        chainId: message.chainId,
        verifyingContract: message.payTo,
      },
      types: FULFILLMENT_SIGNER_CONTROL_TYPES,
      primaryType: "DaskiBazaarFulfillmentSignerControl",
      message: {
        providerAgentId: message.providerAgentId,
        listingEpoch: message.listingEpoch,
        listingCommitment: message.listingCommitment,
        fulfillmentSigner: message.fulfillmentSigner,
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
    fulfillmentSignerControlProof,
    offer: { message, signature },
  };
}

export function createTestRefundPolicy(
  overrides: Partial<BazaarRefundRiskPolicy> = {},
): BazaarRefundRiskPolicy {
  return {
    assurance: "contractual-only",
    refundWallet: privateKeyToAccount(REFUND_WALLET_KEY).address,
    maxSingleGross: 10_000n,
    maxAggregateReserved: 80_000n,
    maxAggregatePaidUnfulfilled: 80_000n,
    maxAggregateRefundDue: 80_000n,
    refundSlaSeconds: 24 * 60 * 60,
    ...overrides,
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
  readonly identity = testAdapterIdentity("facilitator");
  verifyCalls = 0;
  settleCalls = 0;
  verifyError = false;
  settleError = false;
  settleRejected = false;
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

  async settle(
    payload: PaymentPayload,
    _requirements: PaymentRequirements,
    signal: AbortSignal,
  ) {
    this.settleCalls += 1;
    await waitForGate(this.settleGate, signal);
    if (this.settleError) throw new Error("ambiguous settle");
    const authorization = payload.payload.authorization as Record<string, string>;
    return {
      response: {
        success: !this.settleRejected,
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

async function waitForGate(
  gate: Promise<void> | null,
  signal: AbortSignal,
): Promise<void> {
  if (!gate) return;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("adapter aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([gate, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class FakeFulfillment implements BazaarFulfillmentService {
  readonly identity = testAdapterIdentity("fulfillment-service");
  dispatchCalls = 0;
  dispatchError = false;
  dispatchResult: FakeDispatchResult | null = null;
  rawDispatchResult: unknown = undefined;
  rawLifecycleResult: unknown = undefined;
  lifecycleCalls: BazaarLifecycleDispatchInput[] = [];
  lifecycleGate: Promise<void> | null = null;

  async dispatch(input: BazaarDispatchInput): Promise<BazaarDispatchResult> {
    this.dispatchCalls += 1;
    if (this.dispatchError) throw new Error("ambiguous provider dispatch");
    if (this.rawDispatchResult !== undefined) {
      return this.rawDispatchResult as BazaarDispatchResult;
    }
    return {
      orderRecordId: input.orderRecordId,
      ...(this.dispatchResult ?? {
      kind: "accepted" as const,
      taskId: `task-${input.orderRecordId.slice(-12)}`,
      }),
    };
  }

  async performLifecycleAction(
    input: BazaarLifecycleDispatchInput,
    signal: AbortSignal,
  ) {
    this.lifecycleCalls.push(input);
    await waitForGate(this.lifecycleGate, signal);
    if (this.rawLifecycleResult !== undefined) {
      return this.rawLifecycleResult as Awaited<ReturnType<
        BazaarFulfillmentService["performLifecycleAction"]
      >>;
    }
    return {
      assertionNonce: input.assertion.message.nonce,
      result: { state: "working", action: input.action },
    };
  }
}

type FakeDispatchResult =
  | { kind: "accepted"; taskId: string }
  | {
      kind: "rejected";
      reason: "PROVIDER_COMPLIANCE_FAILURE" | "PROVIDER_FULFILLMENT_FAILURE";
    };

export class FakeSettlementObserver {
  readonly identity = testAdapterIdentity("settlement-observer");
  calls: BazaarSettlementObservationInput[] = [];
  result: BazaarSettlementObservationResult = { kind: "pending" };
  error = false;
  gate: Promise<void> | null = null;

  async observe(input: BazaarSettlementObservationInput) {
    this.calls.push(input);
    await this.gate;
    if (this.error) throw new Error("ambiguous settlement observation");
    return this.result;
  }
}

export class FakeFulfillmentObserver implements BazaarFulfillmentObserver {
  readonly identity = testAdapterIdentity("fulfillment-observer");
  calls: BazaarFulfillmentObservationInput[] = [];
  outcome: BazaarFulfillmentOutcome | null = null;
  evidenceHash = keccak256(toBytes("test-fulfillment-evidence"));
  rawResult: unknown = undefined;
  mutate: ((result: Record<string, unknown>) => unknown) | null = null;
  error = false;
  gate: Promise<void> | null = null;

  constructor(private readonly signer: PrivateKeyAccount) {}

  async observe(input: BazaarFulfillmentObservationInput): Promise<
    Awaited<ReturnType<BazaarFulfillmentObserver["observe"]>>
  > {
    this.calls.push(input);
    await this.gate;
    if (this.error) throw new Error("ambiguous fulfillment observation");
    if (this.rawResult !== undefined) {
      return this.rawResult as Awaited<
        ReturnType<BazaarFulfillmentObserver["observe"]>
      >;
    }
    if (!this.outcome) return { kind: "pending" };
    const outcomeHash = keccak256(toBytes(this.outcome));
    const evidenceId = computeBazaarFulfillmentEvidenceId({
      orderRecordId: input.orderRecordId,
      taskIdHash: input.taskIdHash,
      outcome: this.outcome,
      evidenceHash: this.evidenceHash,
    });
    const message = {
      orderRecordId: input.orderRecordId,
      taskIdHash: input.taskIdHash,
      providerAgentId: input.providerAgentId.toString(),
      listingCommitment: input.listingCommitment,
      authorizationDigest: input.authorizationDigest,
      outcomeId: input.outcomeId,
      requestHash: input.requestHash,
      settlementTransaction: input.settlementTransaction,
      outcomeHash,
      evidenceHash: this.evidenceHash,
      evidenceId,
    };
    const result = {
      kind: "attested",
      message,
      signature: await this.signer.signTypedData({
        domain: {
          name: "Daski Bazaar Fulfillment Attestation",
          version: "1",
          chainId: input.chainId,
          verifyingContract: input.payTo,
        },
        types: BAZAAR_FULFILLMENT_ATTESTATION_TYPES,
        primaryType: "DaskiBazaarFulfillmentAttestation",
        message: { ...message, providerAgentId: input.providerAgentId },
      }),
    };
    return (this.mutate?.(result) ?? result) as Awaited<
      ReturnType<BazaarFulfillmentObserver["observe"]>
    >;
  }
}

export class FakeRefundService implements BazaarRefundRequestService {
  readonly identity = testAdapterIdentity("refund-request");
  calls: Parameters<BazaarRefundRequestService["requestRefund"]>[0][] = [];
  result: FakeRefundResult = {
    kind: "deferred",
  };
  rawResult: unknown = undefined;
  error = false;
  gate: Promise<void> | null = null;

  async requestRefund(
    input: Parameters<BazaarRefundRequestService["requestRefund"]>[0],
  ): Promise<Awaited<ReturnType<BazaarRefundRequestService["requestRefund"]>>> {
    this.calls.push(input);
    await this.gate;
    if (this.error) throw new Error("ambiguous provider refund request");
    if (this.rawResult !== undefined) {
      return this.rawResult as Awaited<ReturnType<
        BazaarRefundRequestService["requestRefund"]
      >>;
    }
    return { ...this.result, refundId: input.refundId };
  }
}

type FakeRefundResult =
  | { kind: "broadcast"; transaction: Hex }
  | { kind: "blocked_issuer"; evidenceHash: Hex }
  | { kind: "deferred" };

export class FakeRefundEvidenceVerifier {
  readonly identity = testAdapterIdentity("refund-evidence");
  calls: BazaarRefundEvidenceInput[] = [];
  error = false;
  mutate: ((input: BazaarRefundEvidenceInput) => BazaarRefundEvidenceInput) | null = null;

  async verify(input: BazaarRefundEvidenceInput) {
    this.calls.push(input);
    if (this.error) throw new Error("ambiguous refund evidence");
    return {
      ...(this.mutate?.(input) ?? input),
      finalized: true as const,
      matchingTransferEventCount: 1 as const,
      evidenceHash: REFUND_EVIDENCE_HASH,
      blockHash: REFUND_BLOCK_HASH,
      transferLogIndex: 7,
    };
  }
}

export function accountLifecycleBroker(
  account: PrivateKeyAccount,
): BazaarProviderActionSigningBroker {
  return {
    identity: testAdapterIdentity("provider-action-signing"),
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

export function accountRefundBroker(
  account: PrivateKeyAccount,
): BazaarRefundInstructionSigningBroker {
  return {
    identity: testAdapterIdentity("refund-instruction-signing"),
    address: account.address,
    signRefundInstruction: (input) => account.signTypedData({
      domain: {
        name: "Daski Bazaar Refund Instruction",
        version: "1",
        chainId: BigInt(input.chainId),
        verifyingContract: input.payTo,
      },
      types: BAZAAR_REFUND_INSTRUCTION_TYPES,
      primaryType: "DaskiBazaarRefundInstruction",
      message: {
        ...input.message,
        providerAgentId: BigInt(input.message.providerAgentId),
        grossAmount: BigInt(input.message.grossAmount),
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
