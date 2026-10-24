import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../../src/standardRail/canonical.js";
import { StandardRailCatalog } from "../../src/standardRail/catalog.js";
import type { EvidenceResult, ReleaseEvidenceResult } from "../../src/standardRail/evidence.js";
import { getIntakeRequirements } from "../../src/standardRail/intake.js";
import {
  nextObservation,
  observeOperations,
  type StoredObservation,
  type TerminalEvidence,
} from "../../src/standardRail/operationsStore.js";
import type { OrderAction } from "../../src/standardRail/orderAuthorization.js";
import { createPayerSignatureVerifier } from "../../src/standardRail/payerSignature.js";
import { StandardProviderDispatch } from "../../src/standardRail/providerDispatch.js";
import { StandardPurchaseResponses } from "../../src/standardRail/purchaseResponse.js";
import { issueReadCapability } from "../../src/standardRail/readCapability.js";
import { StandardRailService } from "../../src/standardRail/service.js";
import type { CreateDraftInput } from "../../src/standardRail/store.js";
import type {
  QuoteV1,
  SignedEnvelope,
  StandardListing,
  StandardOrderRecord,
  StandardRailDispatchV2,
} from "../../src/standardRail/types.js";

/// The synthetic provider-wire contract shared by the generator
/// (providerWireFixtures.test.ts) and the consumer (providerWireConsumer.test.ts).
/// Every request is captured from the gateway code that sends it, driven with
/// stubbed persistence, fixed synthetic keys and a fixed clock; every provider
/// response is built by the small reference provider below. Nothing here is
/// private, live or production-derived.

export const PROVIDER_WIRE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "provider-wire");
export const FIXTURE_SCHEMA_VERSION = 1;
export const STARTERS = ["daski-io/provider", "daski-io/provider-full"] as const;
export const LITE = ["daski-io/provider"] as const;
export const FULL = ["daski-io/provider-full"] as const;

// ---------------------------------------------------------------------------
// Synthetic identities. Keys and values derive from public labels, so anyone
// can reproduce them and none can be mistaken for a configured key.

export const keyLabel = (name: string) => `daski provider-wire fixture key: ${name} (test only)`;
export const syntheticHash = (name: string): Hex => keccak256(stringToHex(`daski provider-wire fixture: ${name}`));
export const syntheticAddress = (name: string): Hex => getAddress(`0x${syntheticHash(name).slice(-40)}`);

export const KEY_ROLES = {
  gatewayDispatch: { signerKeyId: "gateway-dispatch",
    role: "Gateway: signs ProviderQuoteRequestV1, ProviderIntakeRequestV1, StandardRailDispatchV2 and DispatchStatusQueryV1" },
  gatewayQuote: { signerKeyId: "gateway-quote", role: "Gateway: signs the QuoteV1 forwarded with every dispatch" },
  gatewayLifecycle: { signerKeyId: "gateway-lifecycle", role: "Gateway: signs ProviderLifecycleGrantV1" },
  providerAuthority: { signerKeyId: null,
    role: "Provider authority key: signs quote, intake, dispatch, dispatch status and lifecycle responses" },
  providerTerminalAttestation: { signerKeyId: null, role: "Provider terminal attestation key: signs terminal attestations" },
  payer: { signerKeyId: null, role: "Buyer EOA: signs OrderActionAuthorizationV1 (EIP-712) for payer-signed lifecycle actions" },
  unrecognized: { signerKeyId: null, role: "Configured by no party: anything it signs must be rejected" },
} as const;
export type KeyName = keyof typeof KEY_ROLES;
const derivedKey = (name: string): Hex => keccak256(stringToHex(keyLabel(name)));
export const PRIVATE_KEYS = Object.fromEntries(
  Object.keys(KEY_ROLES).map((name) => [name, derivedKey(name)]),
) as Record<KeyName, Hex>;
export const ADDRESSES = Object.fromEntries(
  Object.entries(PRIVATE_KEYS).map(([name, key]) => [name, privateKeyToAccount(key).address]),
) as Record<KeyName, Hex>;
// Gateway keys that never sign anything a provider receives. The rail config
// needs them, and a payer equal to any of them would not be reputation eligible.
const GATEWAY_INTERNAL_KEYS = {
  receipt: derivedKey("gatewayReceipt"),
  release: derivedKey("gatewayRelease"),
  reputationOrder: derivedKey("gatewayReputationOrder"),
  reputationRelayer: derivedKey("gatewayReputationRelayer"),
};

export const T0 = 1_790_000_000;
/** The fixed instants (unix seconds) at which the gateway sends, receives and checks. */
export const AT = {
  intake: T0 - 60,
  quote: T0,
  quoteReceived: T0 + 1,
  depositBlock: T0 + 30,
  releaseBlock: T0 + 34,
  releaseObserved: T0 + 50,
  dispatch: T0 + 60,
  dispatchAnswered: T0 + 61,
  retry: T0 + 70,
  // The initial envelope is valid until T0 + 360; a no-claim answer counts
  // only from its validBefore plus 60 seconds.
  noClaimWithinGrace: T0 + 419,
  noClaimAfterGrace: T0 + 420,
  statusWorking: T0 + 600,
  midway: T0 + 900,
  completed: T0 + 3_600,
  statusCompleted: T0 + 3_700,
  lifecycleCompleted: T0 + 4_000,
  support: T0 + 4_200,
  delayedDispatch: T0 + 26 * 3_600,
} as const;

export const CHAIN_ID = 84_532;
export const ENVIRONMENT = "testnet";
export const GATEWAY_URL = "https://gateway.example";
export const PROVIDER_ORIGIN = "https://provider.example";
export const PROVIDER_AGENT_ID = "4242";
export const ORDER_ID = "ord_00000000-0000-4000-8000-000000000001";
export const ORDER_KEY = keccak256(stringToHex(ORDER_ID));
export const ORDER_HANDLE = "providerWireFixtureOrderHandle-000000000001";
export const TASK_ID = "00000000-0000-4000-8000-00000000a001";
export const RAIL_PROFILE_HASH = syntheticHash("active rail profile");
export const REPUTATION_CONTRACT = syntheticAddress("reputation contract");
export const OUTCOME_SCHEMA_UID = syntheticHash("reputation outcome schema");
export const SERVICE_ID = syntheticHash("service id");
export const CONTROL_PROFILE_HASH = syntheticHash("provider control profile");
export const TOKEN = syntheticAddress("token");
export const PROVIDER_PAYEE = syntheticAddress("provider payee");
export const COMMISSION_RECEIVER = syntheticAddress("daski commission receiver");
export const PROVIDER_OWNER = syntheticAddress("provider owner");
export const PROVIDER_AGENT_WALLET = syntheticAddress("provider agent wallet");
export const FACILITATOR_CONFIRMATION_HASH = syntheticHash("facilitator confirmation");
export const COMMISSION_BPS = 500;
export const SUPPORT = {
  requestId: "support-0001",
  messageId: "00000000-0000-4000-8000-0000000000b1",
  reviewId: "00000000-0000-4000-8000-0000000000b2",
} as const;
/** Entropy the gateway draws where the fixtures need it fixed. */
export const NONCES = {
  orderFixed: syntheticHash("order nonce: create-note, payer"),
  orderFixedNoPayer: syntheticHash("order nonce: create-note, no payer"),
  orderDynamic: syntheticHash("order nonce: create-quoted-note"),
  dispatchInitial: syntheticHash("dispatch nonce: initial"),
  dispatchRetry: syntheticHash("dispatch nonce: retry after refusal"),
  dispatchDelayed: syntheticHash("dispatch nonce: delayed first dispatch"),
  action: (action: string, at: number) => syntheticHash(`order action nonce: ${action} at ${at}`),
};

export const CONTROL_PROFILE = {
  providerAgentId: PROVIDER_AGENT_ID,
  providerAudience: PROVIDER_ORIGIN,
  origin: PROVIDER_ORIGIN,
  quoteUrl: `${PROVIDER_ORIGIN}/standard-rail/quote`,
  dispatchUrl: `${PROVIDER_ORIGIN}/standard-rail/dispatch`,
  dispatchStatusUrl: `${PROVIDER_ORIGIN}/standard-rail/dispatch/status`,
  lifecycleUrl: `${PROVIDER_ORIGIN}/standard-rail/lifecycle`,
  timeoutMs: 10_000,
  maxResponseBytes: 65_536,
} as const;

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const noteData = {
  type: "object", additionalProperties: false, required: ["note", "title", "characters"],
  properties: { note: text(128), title: text(80), characters: { type: "integer", minimum: 0, maximum: 2_000 } },
};
export const REQUEST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title"],
  properties: { title: text(80), body: { type: "string", maxLength: 2_000 } },
};
/** The whole completed result a lite provider freezes and delivers. */
export const SERVICE_RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["status"],
  properties: {
    status: { type: "string", enum: ["completed"] },
    message: { type: "string", maxLength: 500 },
    artifacts: { type: "array", maxItems: 4, items: {
      type: "object", additionalProperties: false, required: ["name", "data"],
      properties: { name: text(64), data: noteData },
    } },
  },
};
/** A flat contract the gateway projects a task's data artifacts onto (full). */
export const TASK_PROJECTION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["note", "title", "characters"],
  properties: { ...noteData.properties, accessCode: text(64) },
};

export const BUYER_REQUESTS = {
  fixed: { title: "Synthetic fixture note", body: "Written by the gateway's provider-wire fixtures." },
  dynamic: { title: "Synthetic quoted note", body: "Priced by the provider for each request." },
  intake: { title: "Synthetic fixture note" },
} as const;

const note = { note: "note-0001", title: BUYER_REQUESTS.fixed.title, characters: BUYER_REQUESTS.fixed.body.length };
/** Results the reference provider freezes; resultHash is canonicalHash of the frozen value. */
export const RESULTS = {
  serviceResult: {
    completed: { status: "completed", message: "Note created.", artifacts: [{ name: "note", data: note }] },
    failed: { status: "failed", errorCode: "service_execution_failed" },
  },
  taskProjection: {
    completed: {
      id: TASK_ID,
      status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: "Note created." }] } },
      artifacts: [{ artifactId: "note", name: "note_created", parts: [{ kind: "data", data: note }] }],
    },
    revealed: {
      id: TASK_ID,
      status: { state: "TASK_STATE_COMPLETED", message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: "Note created." }] } },
      artifacts: [{ artifactId: "note", name: "note_created",
        parts: [{ kind: "data", data: { ...note, accessCode: "synthetic-access-code-0001" } }] }],
    },
    canceled: {
      id: TASK_ID,
      status: { state: "TASK_STATE_CANCELED",
        message: { role: "ROLE_AGENT", parts: [{ kind: "text", text: "Canceled at the buyer's request." }] } },
    },
  },
} as const;

export const LISTINGS = {
  fixed: {
    outcomeId: "create-note", pricingMode: "fixed", fixedGrossAmount: "250000", quotePolicy: null,
    listingManifestHash: syntheticHash("listing manifest: create-note"),
    providerOfferHash: syntheticHash("provider offer: create-note"),
    splitter: syntheticAddress("splitter: create-note"),
  },
  dynamic: {
    outcomeId: "create-quoted-note", pricingMode: "dynamic", fixedGrossAmount: "0",
    quotePolicy: { maximumLifetimeSeconds: 180, minimumPaymentWindowSeconds: 30, personalizedPricing: false },
    listingManifestHash: syntheticHash("listing manifest: create-quoted-note"),
    providerOfferHash: syntheticHash("provider offer: create-quoted-note"),
    splitter: syntheticAddress("splitter: create-quoted-note"),
  },
} as const;
export type ListingKind = keyof typeof LISTINGS;
export const DEADLINE_POLICY = {
  draftSeconds: 300, minimumPaymentWindowSeconds: 30, verificationSeconds: 120, settlementEvidenceSeconds: 900,
  releaseEvidenceSeconds: 900, dispatchSeconds: 300, fulfillmentSeconds: 2_592_000,
} as const;

/** The checkout-snapshot listing view the gateway code reads, for one synthetic outcome. */
export function fixtureListing(kind: ListingKind, responseSchema: Record<string, unknown> = SERVICE_RESULT_SCHEMA): StandardListing {
  const facts = LISTINGS[kind];
  return {
    presentation: { serviceName: "Synthetic notes", skillName: facts.outcomeId },
    registrationId: `registration-${facts.outcomeId}`,
    listingId: `listing-${facts.outcomeId}`,
    listingKey: syntheticHash(`listing key: ${facts.outcomeId}`),
    runtimeCommitmentHash: facts.listingManifestHash,
    providerIntentHash: facts.providerOfferHash,
    providerOwner: PROVIDER_OWNER,
    providerAgentWallet: PROVIDER_AGENT_WALLET,
    commitment: { payload: {
      canonicalToken: TOKEN, providerAgentId: PROVIDER_AGENT_ID, serviceId: SERVICE_ID,
      providerAuthorityKey: ADDRESSES.providerAuthority, providerTerminalAttestationKey: ADDRESSES.providerTerminalAttestation,
      providerPayee: PROVIDER_PAYEE, providerControlProfileHash: CONTROL_PROFILE_HASH, outcomeId: facts.outcomeId,
      absoluteResourceUri: `${GATEWAY_URL}/outcomes/${PROVIDER_AGENT_ID}/${facts.outcomeId}`,
      bindingProfile: "recipe-bound-v2", daskiCommissionReceiver: COMMISSION_RECEIVER, commissionBps: COMMISSION_BPS,
      listingEpoch: "1", splitterFactory: syntheticAddress("splitter factory"),
    } },
    manifest: { payload: { splitterAddress: facts.splitter } },
    offer: { payload: {
      outcomeId: facts.outcomeId, skillId: facts.outcomeId, providerAgentId: PROVIDER_AGENT_ID, providerPayee: PROVIDER_PAYEE,
      pricingMode: facts.pricingMode, fixedGrossAmount: facts.fixedGrossAmount,
    } },
    providerControlProfile: { payload: { ...CONTROL_PROFILE } },
    requestSchema: REQUEST_SCHEMA,
    responseSchema,
    screeningPolicy: { providerControlledWallets: [] },
    quotePolicy: facts.quotePolicy ? { ...facts.quotePolicy } : null,
    purchaseReadiness: null,
    capacityPolicy: { maxOpenOrders: 10 },
    deadlinePolicy: { ...DEADLINE_POLICY },
  } as unknown as StandardListing;
}

export const PAYMENT = {
  grossAmount: LISTINGS.fixed.fixedGrossAmount,
  providerNetAmount: "237500",
  daskiCommissionAmount: "12500",
  deposit: { transactionHash: syntheticHash("deposit transaction"), blockNumber: "35000000",
    blockHash: syntheticHash("deposit block"), transactionIndex: 7, logIndex: 12, blockTimestamp: AT.depositBlock },
  release: { transactionHash: syntheticHash("release transaction"), blockNumber: "35000002",
    blockHash: syntheticHash("release block"), transactionIndex: 3, logIndex: 5, releaseSequence: "1",
    blockTimestamp: AT.releaseBlock },
};
const depositEvidence = {
  synthetic: "provider-wire fixture deposit; no chain holds it", orderId: ORDER_ID,
  transactionHash: PAYMENT.deposit.transactionHash, blockNumber: PAYMENT.deposit.blockNumber, logIndex: PAYMENT.deposit.logIndex,
};
const releaseEvidence = {
  synthetic: "provider-wire fixture release; no chain holds it", orderId: ORDER_ID,
  transactionHash: PAYMENT.release.transactionHash, blockNumber: PAYMENT.release.blockNumber,
  releaseSequence: PAYMENT.release.releaseSequence, providerNetAmount: PAYMENT.providerNetAmount,
  daskiCommissionAmount: PAYMENT.daskiCommissionAmount,
};

/** The proven deposit and release the dispatcher binds into the envelope and its evidence bundle. */
export function fixtureEvidence(): { deposit: EvidenceResult; release: ReleaseEvidenceResult } {
  return {
    deposit: {
      transactionHash: PAYMENT.deposit.transactionHash, blockNumber: BigInt(PAYMENT.deposit.blockNumber),
      blockHash: PAYMENT.deposit.blockHash, transactionIndex: PAYMENT.deposit.transactionIndex,
      logIndex: PAYMENT.deposit.logIndex, evidenceHash: canonicalHash(depositEvidence),
      canonicalEvidence: { ...depositEvidence }, sources: ["synthetic-rpc-a", "synthetic-rpc-b"],
    },
    release: {
      transactionHash: PAYMENT.release.transactionHash, blockNumber: BigInt(PAYMENT.release.blockNumber),
      blockHash: PAYMENT.release.blockHash, transactionIndex: PAYMENT.release.transactionIndex,
      logIndex: PAYMENT.release.logIndex, evidenceHash: canonicalHash(releaseEvidence),
      canonicalEvidence: { ...releaseEvidence }, sources: ["synthetic-rpc-a", "synthetic-rpc-b"],
      providerNetAmount: BigInt(PAYMENT.providerNetAmount), daskiCommissionAmount: BigInt(PAYMENT.daskiCommissionAmount),
      releaseSequence: BigInt(PAYMENT.release.releaseSequence),
    },
  };
}

/** The paid order as the gateway holds it, built from the QuoteV1 its challenge issued. */
export function fixtureOrder(
  quote: SignedEnvelope<QuoteV1>, overrides: Partial<StandardOrderRecord> = {},
): StandardOrderRecord {
  const evidence = fixtureEvidence();
  return {
    orderId: ORDER_ID, orderKey: ORDER_KEY, handleHash: Buffer.alloc(32), state: "RELEASE_FINAL",
    providerAgentId: PROVIDER_AGENT_ID, outcomeId: LISTINGS.fixed.outcomeId, bindingProfile: "recipe-bound-v2",
    listingManifestHash: quote.payload.listingManifestHash, providerOfferHash: quote.payload.providerOfferHash,
    listing: fixtureListing("fixed"), quoteHash: canonicalHash(quote), quote,
    canonicalRequestHash: quote.payload.canonicalRequestHash, canonicalRequest: BUYER_REQUESTS.fixed,
    orderNonce: quote.payload.orderNonce, intentId: "int_00000000-0000-4000-8000-000000000002",
    authorizationKey: syntheticHash("authorization key"), paymentPayloadHash: syntheticHash("payment payload"),
    payer: ADDRESSES.payer, expectedPayer: ADDRESSES.payer.toLowerCase() as Hex, grossAmount: quote.payload.grossAmount,
    providerNetAmount: PAYMENT.providerNetAmount, daskiCommissionAmount: PAYMENT.daskiCommissionAmount,
    encryptedPaymentPayload: null, settlementTxHash: evidence.deposit.transactionHash,
    depositEvidenceHash: evidence.deposit.evidenceHash, releaseTxHash: evidence.release.transactionHash,
    releaseEvidenceHash: evidence.release.evidenceHash, providerTaskId: null, railEpoch: "1", capabilityEpoch: 0,
    effectiveFulfillmentSeconds: null, version: 7, leaseFence: 3, expiresAt: new Date((AT.quote + 120) * 1_000),
    createdAt: new Date(AT.quote * 1_000), updatedAt: new Date(AT.releaseObserved * 1_000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Clock, entropy and the HTTP shapes on either side of the wire.

/** Moves the faked Date clock to a fixture instant (unix seconds). */
export const at = (seconds: number) => vi.setSystemTime(seconds * 1_000);

/** The queue the test file's node:crypto mock serves randomBytes from. */
export interface Entropy { queue: Buffer[] }
export function plan(entropy: Entropy, ...values: Hex[]): void {
  entropy.queue.push(...values.map((value) => Buffer.from(value.slice(2), "hex")));
}

export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** The exact bytes the gateway sends. */
  bodyText: string;
}
function wireRequest(url: string, init: RequestInit): WireRequest {
  const bodyText = String(init.body);
  return {
    method: String(init.method),
    url,
    // The provider transport sends exactly these headers (pinnedProviderFetch).
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: JSON.parse(bodyText) as Record<string, unknown>,
    bodyText,
  };
}

export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  /** A JSON body, serialized compactly. */
  body?: unknown;
  /** Exact body text, for bodies JSON cannot express (empty, duplicate keys, HTML). */
  bodyText?: string;
  /** The body is sent gzip-compressed. */
  bodyEncoding?: "gzip";
}
export const json = (status: number, body: unknown, headers: Record<string, string> = {}): WireResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, body });
export const raw = (status: number, bodyText: string, headers: Record<string, string> = {}): WireResponse =>
  ({ status, headers, bodyText });
export function httpResponse(spec: WireResponse): Response {
  let bytes: Buffer | null = spec.bodyText === undefined
    ? Buffer.from(JSON.stringify(spec.body), "utf8")
    : spec.bodyText === "" ? null : Buffer.from(spec.bodyText, "utf8");
  if (bytes && spec.bodyEncoding === "gzip") bytes = gzipSync(bytes);
  return new Response(bytes, { status: spec.status, headers: spec.headers });
}

export type Respond = (request: WireRequest) => Response | Promise<Response>;
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try { return { ok: true, value: await work }; } catch (error) { return { ok: false, error }; }
}

// ---------------------------------------------------------------------------
// Gateway harnesses: the real classes over stubbed persistence.

function railConfig() {
  return {
    environment: ENVIRONMENT, gatewayAudience: GATEWAY_URL, encryptionKey: Buffer.alloc(32, 0x5f),
    dispatchPrivateKey: PRIVATE_KEYS.gatewayDispatch, quotePrivateKey: PRIVATE_KEYS.gatewayQuote,
    lifecyclePrivateKey: PRIVATE_KEYS.gatewayLifecycle, receiptPrivateKey: GATEWAY_INTERNAL_KEYS.receipt,
    releasePrivateKey: GATEWAY_INTERNAL_KEYS.release, reputationOrderPrivateKey: GATEWAY_INTERNAL_KEYS.reputationOrder,
    reputationRelayerPrivateKey: GATEWAY_INTERNAL_KEYS.reputationRelayer,
    dispatchTimeoutMs: 10_000, challengeTtlSeconds: 300, orderReadCapTtlSeconds: 1_800,
    reputationContract: REPUTATION_CONTRACT, reputationOutcomeSchemaUid: OUTCOME_SCHEMA_UID,
    abuse: { walletChallengesOutstandingGlobal: 1_000, assetStateChangesPerPayerPerMinute: 10 },
    manifest: { activeRailProfile: { payload: { railEpoch: "1" } }, providerIdentitySnapshots: [] },
  };
}
const APP_CONFIG = { chainId: CHAIN_ID, publicUrl: GATEWAY_URL };

/** The catalog's own schema validation, without a registration store behind it. */
function catalogHarness(): StandardRailCatalog {
  return Object.assign(Object.create(StandardRailCatalog.prototype) as StandardRailCatalog, {
    validators: new Map(), quarantined: new Set(), catalogMemo: null, discoveryMemo: null,
    registrations: { stopNewCommerce: async () => undefined },
  });
}

interface ServicePrivates {
  resolveGrossAmount(listing: StandardListing, body: unknown, payer: Hex | null): Promise<{
    grossAmount: string; providerQuoteHash: Hex; issuedAt: number; validBefore: number;
  }>;
  resumePaidOrder(order: StandardOrderRecord): Promise<void>;
}
type Harness = Pick<StandardRailService, "issueChallenge" | "issueActionChallenge" | "performAction"> & ServicePrivates;
function gatewayService(fields: Record<string, unknown>): Harness {
  return Object.assign(Object.create(StandardRailService.prototype) as Harness, {
    appConfig: APP_CONFIG, railConfig: railConfig(), purchaseResponses: new StandardPurchaseResponses(),
    releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    salesOutage: { assertOpen: async () => undefined, status: async () => ({ salesOpen: true }) },
    assertAdmissionOpen: () => undefined, assertRailFence: async () => undefined,
    catalog: catalogHarness(), incidents: { record: async () => undefined },
    ...fields,
  });
}

/** Issues a payment challenge: the provider quote request goes out and a QuoteV1 is signed. */
export async function driveChallenge(args: {
  listing: StandardListing; body: Record<string, unknown>; payerAddress?: Hex; respond: Respond;
}): Promise<{ request: WireRequest | null; draft: CreateDraftInput | null; outcome: Outcome<unknown> }> {
  let request: WireRequest | null = null;
  let draft: CreateDraftInput | null = null;
  const service = gatewayService({
    listing: async () => args.listing,
    store: {
      findOpenDraft: async () => null,
      createDraft: async (input: CreateDraftInput) => {
        draft = input;
        return { order: { orderId: ORDER_ID }, handle: ORDER_HANDLE };
      },
    },
    challengeResponse: () => ({ handle: ORDER_HANDLE }),
    providerFetch: async (_listing: unknown, url: string, init: RequestInit) => {
      request = wireRequest(url, init);
      return args.respond(request);
    },
  });
  const outcome = await settle(service.issueChallenge({
    providerAgentId: PROVIDER_AGENT_ID, outcomeId: args.listing.commitment.payload.outcomeId,
    body: args.body, ...(args.payerAddress ? { payerAddress: args.payerAddress } : {}),
  }));
  return { request, draft, outcome };
}

/** The gateway's provider quote exchange alone, as a challenge runs it. */
export async function driveQuote(args: {
  listing: StandardListing; body: unknown; payer: Hex | null; respond: Respond;
}): Promise<{ request: WireRequest | null; outcome: Outcome<Awaited<ReturnType<ServicePrivates["resolveGrossAmount"]>>> }> {
  let request: WireRequest | null = null;
  const service = gatewayService({
    providerFetch: async (_listing: unknown, url: string, init: RequestInit) => {
      request = wireRequest(url, init);
      return args.respond(request);
    },
  });
  const outcome = await settle(service.resolveGrossAmount(args.listing, args.body, args.payer));
  return { request, outcome };
}

export async function driveIntake(args: {
  listing: StandardListing; request: Record<string, unknown>; respond: Respond;
}): Promise<{ request: WireRequest | null; outcome: Outcome<Record<string, unknown>> }> {
  let request: WireRequest | null = null;
  const outcome = await settle(getIntakeRequirements({
    listing: args.listing, request: args.request, environment: ENVIRONMENT, chainId: CHAIN_ID,
    privateKey: PRIVATE_KEYS.gatewayDispatch, timeoutMs: 10_000,
    fetchProvider: async (url, init) => {
      request = wireRequest(url, init);
      return args.respond(request);
    },
  }));
  return { request, outcome };
}

/** Provider operations the gateway keeps for one order, under the gateway's own rules. */
export interface OperationsLedger {
  stored: StoredObservation | null;
  persistOperations(orderId: string, operations: unknown, terminal: TerminalEvidence | null): Promise<void>;
}
export function operationsLedger(stored: StoredObservation | null = null): OperationsLedger {
  const ledger: OperationsLedger = {
    stored,
    async persistOperations(_orderId, input, terminal) {
      const next = nextObservation(ledger.stored, observeOperations(input), terminal);
      if (next) ledger.stored = next;
    },
  };
  return ledger;
}

export interface DispatchRun {
  request: WireRequest | null;
  claimed: SignedEnvelope<StandardRailDispatchV2, 2> | null;
  refusal: { status: number; reason: unknown } | null;
  resolved: { taskId: string; dispatchHash: Hex } | null;
  transitions: Array<{ state: string; reason: string }>;
  order: StandardOrderRecord;
  error: unknown;
}
/** One visit of the gateway's dispatcher to a paid order: a dispatch POST, or a status poll for a persisted claim. */
export async function driveDispatch(args: {
  order: StandardOrderRecord;
  recovery?: { startedAt: number; retryPending?: boolean; nextAttemptAt?: number };
  persisted?: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2>; request: unknown } | null;
  ledger?: OperationsLedger;
  respond: Respond;
}): Promise<DispatchRun> {
  const ledger = args.ledger ?? operationsLedger();
  const recovery = args.recovery ?? { startedAt: AT.releaseObserved };
  const run: DispatchRun = {
    request: null, claimed: null, refusal: null, resolved: null, transitions: [], order: args.order, error: null,
  };
  const dispatcher = new StandardProviderDispatch(
    APP_CONFIG as never,
    railConfig() as never,
    {
      dispatchRecovery: async () => ({
        claim_id: "claim-1", started_at: new Date(recovery.startedAt * 1_000), retry_pending: Boolean(recovery.retryPending),
        next_attempt_at: new Date((recovery.nextAttemptAt ?? recovery.startedAt) * 1_000),
      }),
      dispatchClaim: async () => args.persisted ?? null,
      claimDispatch: async (claim: { dispatch: SignedEnvelope<StandardRailDispatchV2, 2> }) => {
        run.claimed = claim.dispatch;
        return true;
      },
      recordDispatchRefusal: async (_orderId: string, _hash: Hex, status: number, reason: unknown) => {
        run.refusal = { status, reason };
      },
      resolveDispatch: async (_orderId: string, taskId: string, _responseHash: Hex, dispatchHash: Hex) => {
        run.resolved = { taskId, dispatchHash };
      },
    } as never,
    {
      transition: async (order: StandardOrderRecord, state: StandardOrderRecord["state"], reason: string,
        patch: Partial<StandardOrderRecord> = {}) => {
        run.transitions.push({ state, reason });
        return { ...order, ...patch, state };
      },
      persistOperations: ledger.persistOperations,
    } as never,
    async (_listing: StandardListing, url: string, init: RequestInit) => {
      run.request = wireRequest(url, init);
      return args.respond(run.request);
    },
    RAIL_PROFILE_HASH,
  );
  try {
    run.order = await dispatcher.dispatch(args.order, args.order.listing, BUYER_REQUESTS.fixed,
      FACILITATOR_CONFIRMATION_HASH, fixtureEvidence());
  } catch (error) {
    run.error = error;
  }
  return run;
}

/** A buyer lifecycle call: the gateway verifies the buyer's access, grants it and calls the provider. */
export async function driveLifecycle(args: {
  order: StandardOrderRecord;
  action: OrderAction;
  request: Record<string, unknown>;
  access: { readCapability: true } | { authorization: Record<string, unknown> };
  ledger?: OperationsLedger;
  respond: Respond;
}): Promise<{ request: WireRequest | null; outcome: Outcome<unknown>; order: StandardOrderRecord }> {
  const ledger = args.ledger ?? operationsLedger();
  let order = args.order;
  let request: WireRequest | null = null;
  const config = railConfig();
  const service = gatewayService({
    railConfig: config,
    store: {
      findByHandle: async () => order,
      persistOperations: ledger.persistOperations,
      transition: async (current: StandardOrderRecord, state: StandardOrderRecord["state"], _reason: string,
        patch: Partial<StandardOrderRecord> = {}) => (order = { ...current, ...patch, state }),
      bumpCapabilityEpoch: async () => undefined,
    },
    journal: {
      assertActionChallengeOpen: async () => undefined,
      consumeActionChallenge: async () => undefined,
    },
    payerSignature: createPayerSignatureVerifier({ accountTypes: ["eoa"], timeoutMs: 0, endpoints: [] }),
    signedReceipt: async () => ({ artifactType: "StandardRailReceiptV2" }),
    submissionStatus: async () => null,
    confirmationState: { stored: async () => null },
    providerFetch: async (_listing: unknown, url: string, init: RequestInit) => {
      request = wireRequest(url, init);
      return args.respond(request);
    },
  });
  const access = "readCapability" in args.access
    ? { readCapability: issueReadCapability({ key: config.encryptionKey, orderId: order.orderId, payer: order.payer!,
      audience: GATEWAY_URL, capabilityEpoch: order.capabilityEpoch, ttlSeconds: config.orderReadCapTtlSeconds }).readCapability }
    : { authorization: args.access.authorization as never };
  const outcome = await settle(service.performAction({
    handle: ORDER_HANDLE, action: args.action, request: args.request, ...access,
  }));
  return { request, outcome, order };
}

/** The buyer's payer-signed authorization for an order action, over the gateway's own challenge. */
export async function payerAuthorization(args: {
  order: StandardOrderRecord; action: OrderAction; request: Record<string, unknown>; issuedAt: number; entropy: Entropy;
}): Promise<Record<string, unknown>> {
  plan(args.entropy, NONCES.action(args.action, args.issuedAt));
  at(args.issuedAt);
  const service = gatewayService({
    store: { findByHandle: async () => args.order },
    journal: { issueActionChallenge: async () => undefined },
  });
  const { signRequest, ...challenge } = await service.issueActionChallenge({
    handle: ORDER_HANDLE, action: args.action, request: args.request, clientKey: "provider-wire-fixture",
  }) as Record<string, unknown> & { signRequest: Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0] };
  const signature = await privateKeyToAccount(PRIVATE_KEYS.payer).signTypedData(signRequest);
  return { ...challenge, signature };
}

/**
 * One recovery visit to a dispatched order whose provider is still working:
 * the fulfillment deadline is checked against the clock. `state` carries the
 * order and its recorded duration from visit to visit, as the store does.
 */
export async function driveFulfillment(args: {
  state: { order: StandardOrderRecord };
  resolvedAt: number;
  operations: { operations: unknown; accumulatedWaitSeconds: number } | null;
  servicing: () => Promise<number | null>;
}): Promise<{ providerFailed: boolean }> {
  let providerFailed = false;
  const service = gatewayService({
    resumePreSettlement: async (order: StandardOrderRecord) => order,
    // Sales are closed: the sale-time lookup refuses, and must not be asked.
    listing: async () => { throw new Error("SALE_SUSPENDED"); },
    catalog: { servicingFulfillmentSeconds: args.servicing },
    store: {
      findById: async () => args.state.order,
      loadOperations: async () => args.operations,
      transition: async (order: StandardOrderRecord, state: StandardOrderRecord["state"]) => {
        if (state === "PROVIDER_FAILED") providerFailed = true;
        return { ...order, state };
      },
      extendFulfillment: async (order: StandardOrderRecord, seconds: number) =>
        (args.state.order = { ...order, effectiveFulfillmentSeconds: seconds, version: order.version + 1 }),
    },
    journal: {
      dispatchClaim: async () => ({ dispatch: { artifactType: "StandardRailDispatchV2" } }),
      dispatchResolvedAt: async () => new Date(args.resolvedAt * 1_000),
    },
    dispatcher: { reconcile: async (order: StandardOrderRecord) => order },
  });
  await service.resumePaidOrder(args.state.order);
  return { providerFailed };
}

// ---------------------------------------------------------------------------
// The reference provider: what a starter must answer, signed with the
// synthetic provider keys. Signatures are EIP-191 personal_sign over the raw
// 32-byte keccak256 of the canonical JSON; RFC 6979 makes them deterministic.

export function providerSign(key: KeyName, value: unknown): Promise<Hex> {
  return privateKeyToAccount(PRIVATE_KEYS[key]).signMessage({ message: { raw: canonicalHash(value) } });
}

export function operationsView(revision: number, observedAt: number, sections: Record<string, unknown> = {}) {
  return { schemaVersion: 1, revision, observedAt, fulfillment: null, support: null, recovery: null, ...sections };
}

export async function quoteBody(fields: {
  outcomeId: string; listingManifestHash: Hex; requestHash: Hex; grossAmount: string; payer: string | null;
  issuedAt: number; validBefore: number;
}, signer: KeyName = "providerAuthority") {
  const payload = {
    outcomeId: fields.outcomeId, listingManifestHash: fields.listingManifestHash, requestHash: fields.requestHash,
    grossAmount: fields.grossAmount, payer: fields.payer, issuedAt: fields.issuedAt, validBefore: fields.validBefore,
  };
  return { ...payload, signature: await providerSign(signer, payload) };
}

export async function dispatchBody(fields: {
  taskId: string; dispatchHash: Hex; state: string; operations: unknown;
  terminal?: { resultHash: Hex; completedAt: number };
}, keys: { authority?: KeyName; terminal?: KeyName } = {}): Promise<Record<string, unknown>> {
  const signed = { taskId: fields.taskId, dispatchHash: fields.dispatchHash, state: fields.state, operations: fields.operations };
  const body: Record<string, unknown> = { ...signed, signature: await providerSign(keys.authority ?? "providerAuthority", signed) };
  if (fields.terminal) {
    const payload = { taskId: fields.taskId, dispatchHash: fields.dispatchHash, state: fields.state, ...fields.terminal };
    body.terminalAttestation = { payload, signature: await providerSign(keys.terminal ?? "providerTerminalAttestation", payload) };
  }
  return body;
}

export async function lifecycleBody(fields: {
  orderId: string; taskId: string; state: string; operations: unknown; result?: unknown;
  terminal?: { resultHash: Hex; completedAt: number };
}, keys: { authority?: KeyName; terminal?: KeyName } = {}): Promise<Record<string, unknown>> {
  const unsigned: Record<string, unknown> = {
    orderId: fields.orderId, taskId: fields.taskId, state: fields.state, operations: fields.operations,
  };
  if (fields.result !== undefined) unsigned.result = fields.result;
  if (fields.terminal) {
    const payload = { orderId: fields.orderId, taskId: fields.taskId, state: fields.state, ...fields.terminal };
    unsigned.terminalAttestation = { payload, signature: await providerSign(keys.terminal ?? "providerTerminalAttestation", payload) };
  }
  return { ...unsigned, signature: await providerSign(keys.authority ?? "providerAuthority", unsigned) };
}

// ---------------------------------------------------------------------------
// Files and checksums.

export const serializeFixture = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
