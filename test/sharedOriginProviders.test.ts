import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The provider transport resolves an endpoint's host before it sends. The
// example host resolves nowhere, so the lookup answers one fixed public
// address and nothing leaves the process.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));

import type { Config } from "../src/config.js";
import type { Pool } from "../src/db/pool.js";
import type { MarketplaceChainReader, MarketplaceServiceRecord } from "../src/marketplace/reader.js";
import { parseProviderServiceCard } from "../src/serviceRegistration/card.js";
import type { RegistrationEvidenceVerifier } from "../src/serviceRegistration/evidence.js";
import { dynamicRegistrationPolicy, prepareServiceRegistration } from "../src/serviceRegistration/preparation.js";
import { buildRuntimeListingCommitment, runtimeCommitmentHash } from "../src/serviceRegistration/runtimeCommitment.js";
import { ServiceRegistrationService } from "../src/serviceRegistration/service.js";
import type { ServiceRegistrationStore, StoredRegistration } from "../src/serviceRegistration/store.js";
import { verifyStandardRailManifest } from "../src/standardRail/artifacts.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailCatalog } from "../src/standardRail/catalog.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardProviderTransport } from "../src/standardRail/providerTransport.js";
import type { DirectReputationReader } from "../src/standardRail/reputationReader.js";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type {
  ProviderControlProfileV1, QuoteV1, SignedEnvelope, StandardListing, StandardRailDispatchV2, StandardRailManifest,
  WalletAuthorizationTransport,
} from "../src/standardRail/types.js";
import type { StandardWalletStore } from "../src/standardRail/walletStore.js";
import {
  AT, BUYER_REQUESTS, PRIVATE_KEYS as WIRE_KEYS, REQUEST_SCHEMA, SERVICE_RESULT_SCHEMA, TASK_ID, at, driveDispatch,
  driveIntake, driveLifecycle, driveQuote, fixtureOrder, httpResponse, json, raw, type WireRequest,
} from "./helpers/providerWire.js";
import {
  ADDRESSES, ADMITTED_PROVIDER, CHAIN_ID, ENVIRONMENT, GATEWAY_AUDIENCE, NOW, PRIVATE_KEYS, PROFILE_ONLY_PROVIDER,
  RAIL_MANIFEST_EXAMPLES_DIR, SERVICE, SHARED_AUDIENCE, SHARED_ORIGIN, TOKEN, TRUST, providerBase, serviceIdOf,
  type RailManifestExamples,
} from "./helpers/railManifestExamples.js";

// Two providers on one origin. They share an HTTPS origin, one provider wallet
// and one audience, and each is called under its own path. One is admitted for
// servicing with an action catalog; the other carries a control profile only.
// The manifest is the committed accepted.shared-origin example
// (test/fixtures/rail-manifest-examples/). Everything below runs the gateway's
// own code over it: the manifest check, the card check, registration
// preparation, listing assembly, the quote, intake, dispatch, dispatch-status
// and lifecycle calls, the asset list and the retained-contract check. The
// last section gives one of the providers more than one control profile, as a
// manifest carries them while a provider moves to another wallet, and pins
// which of them the provider is sold through.

const committed = JSON.parse(
  readFileSync(path.join(RAIL_MANIFEST_EXAMPLES_DIR, "examples.json"), "utf8"),
) as RailManifestExamples;
const manifest: StandardRailManifest =
  committed.examples.find((example) => example.id === "accepted.shared-origin")!.manifest;
const profileOf = (providerAgentId: string): SignedEnvelope<ProviderControlProfileV1> =>
  manifest.providerControlProfiles.find((profile) => profile.payload.providerAgentId === providerAgentId)!;
const admission = manifest.servicingAdmissions[0]!;

const PROVIDERS = [ADMITTED_PROVIDER, PROFILE_ONLY_PROVIDER] as const;
const OUTCOME_ID = "create-note";
const PRICE = "250000";
const ENDPOINTS = ["quoteUrl", "dispatchUrl", "dispatchStatusUrl", "lifecycleUrl", "assetQueryUrl", "assetActionUrl"] as const;
const CARD_TEXTS = ["origin", "providerAudience", ...ENDPOINTS] as const;
const SHARED_WALLET = ADDRESSES.sharedProviderWallet;
const synthetic = (name: string): Hex => keccak256(stringToHex(`shared-origin provider test: ${name}`));
const syntheticAddress = (name: string): Address => getAddress(`0x${synthetic(name).slice(-40)}`);

const splitterCreationCode: Hex = "0x6001600101";
const appConfig = { chainId: CHAIN_ID, publicUrl: GATEWAY_AUDIENCE, usdc: { address: TOKEN } } as unknown as Config;
const railConfig = {
  environment: ENVIRONMENT,
  gatewayAudience: GATEWAY_AUDIENCE,
  signers: localGatewaySigners(PRIVATE_KEYS.manifestSigner),
  trustedSigners: new Map<string, readonly Address[]>(Object.entries(TRUST.trustedSigners)),
  splitterCreationCodeHash: keccak256(splitterCreationCode),
  splitterFactoryRuntimeCodeHash: synthetic("splitter factory runtime code"),
  dynamicListingPolicy: {
    splitterCreationCode, splitterFactory: syntheticAddress("splitter factory"),
    daskiCommissionReceiver: syntheticAddress("commission receiver"), commissionBps: 500,
  },
  screeningPolicy: {
    sanctionsOracle: syntheticAddress("sanctions oracle"),
    sanctionsOracleRuntimeCodeHash: synthetic("sanctions oracle runtime code"),
  },
  dispatchTimeoutMs: 10_000,
  abuse: {
    federationMaxProviders: 20, federationPerProviderConcurrency: 4, federationGlobalConcurrency: 20,
    federationPerProviderPerMinute: 120, federationGlobalPerMinute: 300,
  },
  manifest,
} as unknown as StandardRailConfig;

// ---------------------------------------------------------------------------
// Each provider's card, registration and admitted listing.

/** The eight standard-rail texts of a card, as its control profile carries them. */
const cardTexts = (profile: ProviderControlProfileV1) =>
  Object.fromEntries(CARD_TEXTS.map((name) => [name, profile[name]])) as Record<typeof CARD_TEXTS[number], string>;

function providerCard(providerAgentId: string, standardRail: Record<string, string>, serviceType = "note-keeping") {
  const contract = {
    inputSchema: REQUEST_SCHEMA, resultSchema: SERVICE_RESULT_SCHEMA,
    pricing: { USDC: { type: "one-time", fixed_amount: PRICE } },
    paymentRequired: true, requiresAssetOwnership: false, assetType: null, fulfillmentMode: "automated",
    purchaseReadiness: null, capacity: { maxOpenOrders: 10 }, deadlines: { dispatchSeconds: 300 }, assetAction: null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1, serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version, skillId: OUTCOME_ID, contract,
  });
  const base = providerBase(providerAgentId);
  return {
    name: `Notes by provider ${providerAgentId}`, description: "Keeps a note.",
    extensions: {
      "https://daski.io/a2a/v1": { legal: {
        marketplaceTermsUrl: "https://marketplace.example/terms", marketplacePrivacyUrl: "https://marketplace.example/privacy",
        providerLegalName: `Example Provider ${providerAgentId}`,
        providerTermsUrl: `${base}/terms`, providerPrivacyUrl: `${base}/privacy`,
      } },
      "https://daski.io/a2a/v2": {
        schemaVersion: 1, providerAgentId,
        service: {
          serviceId: serviceIdOf(providerAgentId), slug: SERVICE.slug, version: SERVICE.version,
          categoryFamily: "productivity", serviceType, jurisdictions: ["global"], lifecycle: "available",
          turnaroundEstimate: "PT1M", acceptingNewOrders: true,
        },
        standardRail,
        skillContractSetHash: canonicalHash([{ skillId: OUTCOME_ID, skillContractHash }]),
        skills: [{
          skillId: OUTCOME_ID, skillContractHash, acceptingNewOrders: true,
          presentation: { name: "Create a note", description: "Creates a note.", examples: [], tags: ["notes"],
            documentationUrl: `${base}/docs` },
          contract,
        }],
      },
    },
  };
}

interface Registered {
  providerAgentId: string;
  profile: SignedEnvelope<ProviderControlProfileV1>;
  owner: Address;
  chainService: MarketplaceServiceRecord;
  record: StoredRegistration;
  listingId: string;
  listingHash: Hex;
}
interface ListingRow {
  listingId: string;
  state: string;
  acceptingNewOrders: boolean;
  runtimeCommitmentHash: Hex | null;
  runtimeCommitment: unknown;
  activationCheckpoint: unknown;
  splitterTransactionHash: Hex | null;
}
const listingRows = new Map<string, ListingRow>();
const registered = new Map<string, Registered>();

async function register(providerAgentId: string): Promise<Registered> {
  const profile = profileOf(providerAgentId);
  const serviceId = serviceIdOf(providerAgentId);
  const agentCardUrl = `${providerBase(providerAgentId)}/.well-known/agent-card.json`;
  const owner = privateKeyToAccount(synthetic(`owner key of provider ${providerAgentId}`));
  const payee = syntheticAddress(`payee of provider ${providerAgentId}`);
  const card = parseProviderServiceCard(providerCard(providerAgentId, cardTexts(profile.payload)), {
    providerAgentId, serviceId, serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version, agentCardUrl,
  });
  const chainService: MarketplaceServiceRecord = {
    providerAgentId, serviceId, serviceSlug: SERVICE.slug, version: SERVICE.version, serviceUri: agentCardUrl,
    serviceWallet: payee, active: true, createdAt: "1",
    standardReputation: { completed: "0", failed: "0", canceled: "0", confirmed: "0", notConfirmed: "0",
      refundedAmount: "0", transactions: "0", safeBlock: "1" },
  };
  const policy = dynamicRegistrationPolicy(appConfig, railConfig);
  const intent = await signEnvelope({
    artifactType: "ProviderServiceRegistrationIntentV1", environment: ENVIRONMENT, chainId: CHAIN_ID,
    audience: GATEWAY_AUDIENCE, signerKeyId: "provider-authority", account: owner, issuedAt: NOW, validBefore: NOW + 600,
    payload: {
      providerAgentId, serviceId, serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version, providerPayee: payee,
      serviceContractHash: card.serviceContractHash, skillContractSetHash: card.skillContractSetHash,
      skills: card.skills.map(({ skillId, skillContractHash }) => ({ skillId, skillContractHash })),
      railPolicyHash: policy.policyVersionHash, registrationNonce: synthetic(`registration nonce ${providerAgentId}`),
    },
  });
  const registrationId = randomUUID();
  // Both providers register the one shared wallet as their agent wallet.
  const prepared = await prepareServiceRegistration({
    registrationId, intent, card, agentWallet: SHARED_WALLET, service: chainService, config: appConfig, railConfig,
  });
  const listing = prepared.listings[0]!;
  // The commitment an activation records for a new listing (ServiceRegistrationService.runtimeCommitmentsFor).
  const commitment = buildRuntimeListingCommitment({
    environment: ENVIRONMENT, chainId: CHAIN_ID, gatewayAudience: GATEWAY_AUDIENCE, providerAgentId, serviceId,
    currentProviderIntentHash: prepared.providerIntentHash, currentProviderPayee: getAddress(prepared.providerPayee),
    policy,
    listing: {
      listingId: listing.listingId, listingKey: listing.listingKey, skillId: listing.skillId,
      skillContractHash: listing.skillContractHash, paymentRequired: listing.paymentRequired,
      splitterAddress: listing.splitterAddress, preparation: listing.preparation, controlProfile: listing.controlProfile,
    },
  });
  const listingHash = runtimeCommitmentHash(commitment);
  listingRows.set(listing.listingId, {
    listingId: listing.listingId, state: "ACTIVE", acceptingNewOrders: true, runtimeCommitmentHash: listingHash,
    runtimeCommitment: commitment,
    activationCheckpoint: {
      splitterDeploymentTransactionHash: synthetic(`splitter deployment ${providerAgentId}`),
      splitterDeploymentBlockNumber: "100", splitterDeploymentBlockHash: synthetic("block 100"),
      splitterRuntimeCodeHash: synthetic("splitter runtime code"), splitterActivationBlockNumber: "100",
      splitterActivationBlockHash: synthetic("block 100"), splitterActivationPosition: "END_OF_BLOCK",
      splitterStartingTokenBalance: "0", splitterStartingReleaseSequence: "0",
    },
    splitterTransactionHash: synthetic(`splitter deployment ${providerAgentId}`),
  });
  const now = new Date();
  const record: StoredRegistration = {
    registrationId, providerAgentId, serviceId, serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version,
    supersedesRegistrationId: null, agentCardUrl, serviceWallet: payee, idempotencyKey: `register-${providerAgentId}`,
    providerPayee: payee, providerOwner: owner.address, providerAgentWallet: SHARED_WALLET, providerSigner: owner.address,
    requestHash: canonicalHash(intent), intent, prepared, card, state: "ACTIVE", marketplaceEnabled: true,
    marketplaceEnabledBy: "environment-default", marketplaceEnabledAt: now, cardAcceptingOrders: true, chainActive: true,
    evidence: null, registrationHealthy: true, refreshFailures: 0, lastRefreshErrorCode: null, lastRefreshedAt: now,
    activatedAt: now, lastRefreshAttemptedAt: now, createdAt: now, updatedAt: now,
  };
  return { providerAgentId, profile, owner: owner.address, chainService, record, listingId: listing.listingId, listingHash };
}

/** What a test changes in the stored state the catalog reads. */
interface StoredState {
  /** The agent wallet a provider's registration names, where it is not the shared wallet. */
  agentWallets?: Record<string, Address>;
  /** The profile hash recorded as a provider's current one, or null for none, where it is not the default below. */
  currentProfileHashes?: Record<string, Hex | null>;
}

/** The registration store as the catalog reads it, over the two registrations. */
function registrationStore(state: StoredState = {}): ServiceRegistrationStore {
  const recordOf = (provider: Registered): StoredRegistration => {
    const agentWallet = state.agentWallets?.[provider.providerAgentId];
    return agentWallet ? { ...provider.record, providerAgentWallet: agentWallet } : provider.record;
  };
  const records = () => [...registered.values()].map(recordOf);
  const recorded = state.currentProfileHashes ?? {};
  return {
    listActiveByProvider: async (providerAgentId: string) =>
      records().filter((record) => record.providerAgentId === providerAgentId),
    listVisibleForReadiness: async () => records(),
    listPublic: async () => records(),
    registrationForListingHash: async (hash: string) => {
      const provider = [...registered.values()].find((candidate) => candidate.listingHash === hash);
      return provider ? recordOf(provider) : null;
    },
    listingCommitments: async (ids: readonly string[]) =>
      ids.flatMap((id) => listingRows.has(id) ? [listingRows.get(id)!] : []),
    getArtifact: async () => null,
    // The servicing-admission table names a current profile for an admitted
    // provider only. Without a row the catalog takes the manifest's profile.
    currentProviderControlProfileHash: async (providerAgentId: string) =>
      providerAgentId in recorded ? recorded[providerAgentId]
        : providerAgentId === admission.payload.providerAgentId ? admission.payload.providerControlProfileHash : null,
  } as unknown as ServiceRegistrationStore;
}

const catalog = (config: StandardRailConfig = railConfig, state: StoredState = {}) => new StandardRailCatalog(
  config, appConfig, registrationStore(state), async () => undefined,
  { forOutcomes: async () => { throw new Error("reputation offline"); } } as unknown as DirectReputationReader,
);
/** The gateway's start-up check of a manifest, under this file's trust inputs. */
const startUpCheck = (value: StandardRailManifest) => verifyStandardRailManifest(value, {
  environment: ENVIRONMENT, chainId: appConfig.chainId, gatewayAudience: railConfig.gatewayAudience,
  signers: railConfig.trustedSigners,
  splitterFactoryRuntimeCodeHash: railConfig.splitterFactoryRuntimeCodeHash,
  splitterCreationCodeHash: railConfig.splitterCreationCodeHash,
});
/** The listing a purchase is sold from, read while the registrations are fresh. */
function listingOf(providerAgentId: string): Promise<StandardListing> {
  at(NOW);
  return catalog().listing(providerAgentId, OUTCOME_ID);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(NOW);
  for (const providerAgentId of PROVIDERS) registered.set(providerAgentId, await register(providerAgentId));
});
afterAll(() => { vi.useRealTimers(); });

describe("a manifest with two providers on one origin", () => {
  it("verifies under the gateway's start-up check", async () => {
    at(NOW);
    await expect(startUpCheck(manifest)).resolves.toBeUndefined();
  });

  it("carries one origin, one provider wallet and one audience, and a path for each provider", () => {
    const [first, second] = PROVIDERS.map((providerAgentId) => profileOf(providerAgentId).payload);
    expect(first!.providerAgentId).not.toBe(second!.providerAgentId);
    for (const profile of [first!, second!]) {
      expect(profile.origin).toBe("https://shared.example");
      expect(profile.providerAudience).toBe("https://shared.example/");
      expect(profile.assetResponseKey).toBe(SHARED_WALLET);
      for (const name of ENDPOINTS) {
        expect(profile[name].startsWith(`https://shared.example/p/${profile.providerAgentId}/standard-rail/`), name).toBe(true);
      }
    }
    expect(SHARED_ORIGIN).toBe("https://shared.example");
    expect(SHARED_AUDIENCE).toBe("https://shared.example/");
  });

  it("admits one provider for servicing and carries a control profile only for the other", () => {
    const agents = (envelopes: Array<{ payload: { providerAgentId: string } }>) =>
      envelopes.map((envelope) => envelope.payload.providerAgentId);
    expect(agents(manifest.providerControlProfiles)).toEqual([ADMITTED_PROVIDER, PROFILE_ONLY_PROVIDER]);
    expect(agents(manifest.servicingAdmissions)).toEqual([ADMITTED_PROVIDER]);
    expect(agents(manifest.actionCatalogs)).toEqual([ADMITTED_PROVIDER]);
  });
});

describe("the card of a provider on the shared origin", () => {
  const expected = (providerAgentId: string) => ({
    providerAgentId, serviceId: serviceIdOf(providerAgentId), serviceSlug: SERVICE.slug, serviceVersion: SERVICE.version,
    agentCardUrl: `${providerBase(providerAgentId)}/.well-known/agent-card.json`,
  });

  it.each(PROVIDERS)("passes the card check and stores exactly the texts its control profile carries: %s", (providerAgentId) => {
    const profile = profileOf(providerAgentId).payload;
    const card = parseProviderServiceCard(providerCard(providerAgentId, cardTexts(profile)), expected(providerAgentId));
    expect(card.standardRail).toEqual(cardTexts(profile));
    expect(card.standardRail.origin).toBe("https://shared.example");
    expect(card.standardRail.providerAudience).toBe("https://shared.example/");
    expect(registered.get(providerAgentId)!.record.card.standardRail).toEqual(cardTexts(profile));
  });

  it("stores the same two texts whichever way the card spells its origin and audience", () => {
    const profile = profileOf(PROFILE_ONLY_PROVIDER).payload;
    const card = parseProviderServiceCard(providerCard(PROFILE_ONLY_PROVIDER, {
      ...cardTexts(profile), origin: "https://shared.example/", providerAudience: "https://shared.example",
    }), expected(PROFILE_ONLY_PROVIDER));
    expect(card.standardRail).toEqual(cardTexts(profile));
  });
});

describe("listings of two providers on one origin", () => {
  it("assemble from the one manifest, each with its own control profile", async () => {
    at(NOW);
    const current = catalog();
    const listings = new Map<string, StandardListing>();
    for (const providerAgentId of PROVIDERS) listings.set(providerAgentId, await current.listing(providerAgentId, OUTCOME_ID));
    for (const providerAgentId of PROVIDERS) {
      const provider = registered.get(providerAgentId)!;
      const listing = listings.get(providerAgentId)!;
      expect(listing.providerControlProfile).toEqual(provider.profile);
      expect(listing.commitment.payload.providerControlProfileHash).toBe(canonicalHash(provider.profile));
      expect(listing.commitment.payload.providerAgentId).toBe(providerAgentId);
      expect(listing.commitment.payload.serviceId).toBe(serviceIdOf(providerAgentId));
      expect(listing.commitment.payload.providerAuthorityKey).toBe(SHARED_WALLET);
      expect(listing.runtimeCommitmentHash).toBe(provider.listingHash);
      expect(listing.offer.payload).toMatchObject({ pricingMode: "fixed", fixedGrossAmount: PRICE });
    }
    const [first, second] = PROVIDERS.map((providerAgentId) => listings.get(providerAgentId)!);
    expect(first!.runtimeCommitmentHash).not.toBe(second!.runtimeCommitmentHash);
    expect(first!.commitment.payload.providerControlProfileHash).not.toBe(second!.commitment.payload.providerControlProfileHash);
    expect(first!.manifest.payload.splitterAddress).not.toBe(second!.manifest.payload.splitterAddress);
  });

  it("are both public and both in the readiness inventory, the profile-only provider's included", async () => {
    at(NOW);
    const current = catalog();
    const rows = await current.listOutcomes();
    expect(rows.map((row) => [row.providerAgentId, row.outcomeId, row.providerAudience])).toEqual(
      PROVIDERS.map((providerAgentId) => [providerAgentId, OUTCOME_ID, "https://shared.example/"]));
    expect(rows.map((row) => row.listingManifestHash)).toEqual(
      PROVIDERS.map((providerAgentId) => registered.get(providerAgentId)!.listingHash));
    const inventory = await current.validateCommerce(rows.map((row) => row.listingManifestHash));
    expect(inventory.map((item) => item.listingManifestHash).sort()).toEqual(
      rows.map((row) => row.listingManifestHash).sort());
    await expect(current.getOutcome(PROFILE_ONLY_PROVIDER, OUTCOME_ID)).resolves.toMatchObject({
      providerAgentId: PROFILE_ONLY_PROVIDER, payTo: registered.get(PROFILE_ONLY_PROVIDER)!.record.prepared.listings[0]!.splitterAddress,
    });
  });

  it("do not assemble for a provider whose registered wallet is not the profile's", async () => {
    const provider = registered.get(PROFILE_ONLY_PROVIDER)!;
    const original = provider.record;
    provider.record = { ...original, providerAgentWallet: syntheticAddress("another wallet") };
    try {
      await expect(listingOf(PROFILE_ONLY_PROVIDER)).rejects.toThrow("Provider control profile key is not the provider wallet");
      await expect(listingOf(ADMITTED_PROVIDER)).resolves.toBeDefined();
    } finally {
      provider.record = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Calls. Every request the gateway sends for a listing passes the real
// transport's origin check, then stops at a stub that records where it went.

interface Sent { url: string; body: Record<string, unknown> }

type Calls = Record<"quote" | "intake" | "dispatch" | "dispatchStatus" | "lifecycle", Sent>;

/**
 * The gateway's quote, intake, dispatch, dispatch-status and lifecycle calls
 * for one provider's listing. The provider answers the quote with the key
 * given: the one shared wallet unless a test names another.
 */
async function callsFor(listing: StandardListing, providerWalletKey: Hex = PRIVATE_KEYS.sharedProviderWallet): Promise<Calls> {
  const sent: Sent[] = [];
  const through = (answer: (request: WireRequest) => Response | Promise<Response>) => (request: WireRequest) =>
    new StandardProviderTransport((async (url: string | URL | Request) => {
      sent.push({ url: String(url), body: request.body });
      return answer(request);
    }) as typeof fetch).fetch(listing, request.url, { method: request.method, headers: request.headers, body: request.bodyText });
  const last = () => sent[sent.length - 1]!;
  const providerWallet = privateKeyToAccount(providerWalletKey);
  const payer = privateKeyToAccount(WIRE_KEYS.payer).address.toLowerCase() as Hex;

  at(AT.quote);
  const quoted = await driveQuote({ listing, body: BUYER_REQUESTS.fixed, payer, respond: through(async (request) => {
    const { outcomeId, listingManifestHash, requestHash } =
      (request.body.request as { payload: { outcomeId: string; listingManifestHash: Hex; requestHash: Hex } }).payload;
    const answer = { outcomeId, listingManifestHash, requestHash, grossAmount: PRICE, payer,
      issuedAt: AT.quote, validBefore: AT.quote + 120 };
    // By default the provider answers with the one shared wallet, whichever provider was asked.
    return httpResponse(json(200, { ...answer,
      signature: await providerWallet.signMessage({ message: { raw: canonicalHash(answer) } }) }));
  }) });
  if (!quoted.outcome.ok) throw quoted.outcome.error;
  expect(quoted.outcome.value.grossAmount).toBe(PRICE);
  const quote = last();

  at(AT.intake);
  await driveIntake({ listing, request: { ...BUYER_REQUESTS.intake }, respond: through(() => httpResponse(raw(503, ""))) });
  const intake = last();

  const pricing = quoted.outcome.value;
  const issuedQuote = await signEnvelope<QuoteV1>({
    artifactType: "QuoteV1", environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE,
    signerKeyId: "gateway-quote", account: privateKeyToAccount(WIRE_KEYS.gatewayQuote),
    issuedAt: pricing.issuedAt, validBefore: pricing.validBefore,
    payload: {
      listingManifestHash: listing.runtimeCommitmentHash, providerOfferHash: listing.providerIntentHash,
      providerQuoteHash: pricing.providerQuoteHash, canonicalRequestHash: canonicalHash(BUYER_REQUESTS.fixed),
      grossAmount: pricing.grossAmount, token: listing.commitment.payload.canonicalToken,
      splitter: listing.manifest.payload.splitterAddress, orderNonce: synthetic("order nonce"),
      issuedAt: pricing.issuedAt, validBefore: pricing.validBefore,
    },
  });
  const order = fixtureOrder(issuedQuote, {
    providerAgentId: listing.commitment.payload.providerAgentId, outcomeId: listing.commitment.payload.outcomeId, listing,
  });

  at(AT.dispatch);
  const first = await driveDispatch({ order, respond: through(() => httpResponse(raw(503, ""))) });
  if (!first.claimed) throw first.error ?? new Error("No dispatch was sent");
  const dispatch = last();

  at(AT.retry);
  await driveDispatch({
    order: { ...order, state: "DISPATCH_AMBIGUOUS" },
    persisted: { dispatch: first.claimed as SignedEnvelope<StandardRailDispatchV2, 2>, request: BUYER_REQUESTS.fixed },
    respond: through(() => httpResponse(raw(503, ""))),
  });
  const dispatchStatus = last();

  at(AT.midway);
  await driveLifecycle({
    order: { ...order, state: "DISPATCHED", providerTaskId: TASK_ID }, action: "status", request: {},
    access: { readCapability: true }, respond: through(() => httpResponse(json(503, { error: "lifecycle_unavailable" }))),
  });
  const lifecycle = last();

  expect(sent).toHaveLength(5);
  return { quote, intake, dispatch, dispatchStatus, lifecycle };
}

describe("calls to two providers on one origin", () => {
  it.each(PROVIDERS)("go to provider %s's own path with the shared audience and its own profile hash", async (providerAgentId) => {
    const other = PROVIDERS.find((candidate) => candidate !== providerAgentId)!;
    const provider = registered.get(providerAgentId)!;
    const profile = provider.profile.payload;
    const calls = await callsFor(await listingOf(providerAgentId));

    expect(calls.quote.url).toBe(`https://shared.example/p/${providerAgentId}/standard-rail/quote`);
    expect(calls.intake.url).toBe(`https://shared.example/p/${providerAgentId}/standard-rail/quote`);
    expect(calls.dispatch.url).toBe(`https://shared.example/p/${providerAgentId}/standard-rail/dispatch`);
    expect(calls.dispatchStatus.url).toBe(`https://shared.example/p/${providerAgentId}/standard-rail/dispatch/status`);
    expect(calls.lifecycle.url).toBe(`https://shared.example/p/${providerAgentId}/standard-rail/lifecycle`);
    expect([calls.quote.url, calls.dispatch.url, calls.dispatchStatus.url, calls.lifecycle.url])
      .toEqual([profile.quoteUrl, profile.dispatchUrl, profile.dispatchStatusUrl, profile.lifecycleUrl]);
    const otherUrls = Object.values(cardTexts(profileOf(other).payload));
    for (const call of Object.values(calls)) {
      expect(new URL(call.url).pathname.startsWith(`/p/${providerAgentId}/`), call.url).toBe(true);
      expect(new URL(call.url).pathname.startsWith(`/p/${other}/`), call.url).toBe(false);
      expect(otherUrls).not.toContain(call.url);
    }

    // Every envelope is addressed to the one shared audience; the provider is
    // named by the listing and profile hashes inside it.
    const envelope = (value: unknown) => value as { audience: string; payload: Record<string, unknown> };
    for (const signed of [calls.quote.body.request, calls.intake.body.request, calls.dispatch.body.dispatch,
      calls.dispatchStatus.body.query, calls.lifecycle.body.grant]) {
      expect(envelope(signed).audience).toBe("https://shared.example/");
    }
    expect(envelope(calls.quote.body.request).payload.listingManifestHash).toBe(provider.listingHash);
    expect(envelope(calls.dispatch.body.dispatch).payload).toMatchObject({
      providerAudience: "https://shared.example/",
      providerControlProfileHash: canonicalHash(provider.profile),
      listingManifestHash: provider.listingHash,
      serviceId: serviceIdOf(providerAgentId),
    });
    expect(envelope(calls.dispatch.body.dispatch).payload.providerControlProfileHash)
      .not.toBe(canonicalHash(profileOf(other)));
  });

  it("are refused by the transport for an endpoint off the profile's origin", async () => {
    const listing = await listingOf(PROFILE_ONLY_PROVIDER);
    const fetchFn = vi.fn(async () => new Response("{}"));
    const transport = new StandardProviderTransport(fetchFn as unknown as typeof fetch);
    await expect(transport.fetch(listing, `https://other.example/p/${PROFILE_ONLY_PROVIDER}/standard-rail/dispatch`, {}))
      .rejects.toThrow("PROVIDER_ENDPOINT_ORIGIN_MISMATCH");
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(transport.fetch(listing, listing.providerControlProfile.payload.dispatchUrl, {})).resolves.toBeDefined();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Assets. The payer has an order with each provider; only the admitted one is asked.

describe("the asset list across two providers on one origin", () => {
  const payer = privateKeyToAccount(WIRE_KEYS.payer).address;
  const eligible = [...PROVIDERS].sort();

  function federation(asked: string[]) {
    const idle = { rows: [] as unknown[] };
    const client = {
      query: async (sql: string) => sql.includes("pg_try_advisory_lock") ? { rows: [{ acquired: true }] } : idle,
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        if (sql.includes("SELECT DISTINCT provider_agent_id")) {
          return { rows: eligible.map((providerAgentId) => ({ provider_agent_id: providerAgentId })) };
        }
        if (sql.includes("rate_limit_buckets")) return { rows: [{ request_count: 1 }] };
        return idle; // No servicing admission is recorded as current yet.
      },
    } as unknown as Pool;
    const wallet = {
      consume: async () => ({ payer, authorizationHash: synthetic("wallet authorization") }),
    } as unknown as StandardWalletStore;
    return new StandardAssetFederation(pool, railConfig, CHAIN_ID, wallet, async (_listing, endpoint) => {
      asked.push(endpoint);
      return new Response("", { status: 503 });
    });
  }

  it("answers not-admitted with no assets for the profile-only provider and calls only the admitted one", async () => {
    at(NOW);
    const asked: string[] = [];
    const assets = federation(asked);
    const listed = await assets.listAssets({
      payer, providerAgentId: null, limit: 20, cursor: null,
      authorization: { message: { absoluteResourceUriHash: synthetic("wallet assets resource") }, signature: "0x" } as
        unknown as WalletAuthorizationTransport,
    });
    expect(listed.providers).toEqual([
      { providerAgentId: ADMITTED_PROVIDER, availability: "unavailable", assets: [], nextCursor: null },
      { providerAgentId: PROFILE_ONLY_PROVIDER, availability: "not-admitted", assets: [], nextCursor: null },
    ]);
    expect(asked).toEqual([`https://shared.example/p/${ADMITTED_PROVIDER}/standard-rail/assets/query`]);
    expect(assets.activeServicing(ADMITTED_PROVIDER)?.listing.providerControlProfile).toEqual(profileOf(ADMITTED_PROVIDER));
    expect(assets.activeServicing(PROFILE_ONLY_PROVIDER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The retained-contract check. When a provider's card changes, the gateway
// keeps selling the admitted listing only if the outcomes list at the root of
// the card's origin answers the stored audience and lists it as executable.
// Two providers on one origin share that one root list.

describe("the retained-contract check for two providers on one origin", () => {
  const OUTCOMES_URL = "https://shared.example/standard-rail/outcomes";
  const executable = (providerAgentIds: readonly string[]) => providerAgentIds.map((providerAgentId) => ({
    providerAgentId, outcomeId: OUTCOME_ID, listingManifestHash: registered.get(providerAgentId)!.listingHash, executable: true,
  }));

  /** One refresh of the provider's registration after its card changed, against the given root outcomes answer. */
  async function refresh(providerAgentId: string, code: "AGENT_CARD_INVALID" | "CARD_CONTRACT_DRIFT", outcomes: unknown) {
    const provider = registered.get(providerAgentId)!;
    const loaded: string[] = [];
    const store = {
      listingCommitments: async (ids: readonly string[]) => ids.flatMap((id) => listingRows.has(id) ? [listingRows.get(id)!] : []),
      retainDuringContractDrift: vi.fn(async () => undefined),
      stopNewCommerce: vi.fn(async () => undefined),
      refreshFailed: vi.fn(async () => undefined),
      refreshed: vi.fn(async () => undefined),
    };
    const marketplace = {
      getService: async () => provider.chainService,
      getProvider: async () => ({
        agentId: providerAgentId, active: true, identity: { owner: provider.owner, agentWallet: SHARED_WALLET },
      }),
    } as unknown as MarketplaceChainReader;
    const service = new ServiceRegistrationService(
      appConfig, railConfig, store as unknown as ServiceRegistrationStore, marketplace, {} as RegistrationEvidenceVerifier,
      async (url) => {
        loaded.push(url);
        if (url === OUTCOMES_URL) return outcomes;
        // The card now publishes a different service contract, or nothing the gateway can read.
        return code === "AGENT_CARD_INVALID" ? { name: "Not a provider card" }
          : providerCard(providerAgentId, cardTexts(provider.profile.payload), "note-archiving");
      },
    );
    await service.refreshRegistration(provider.record);
    expect(store.refreshed).not.toHaveBeenCalled();
    expect(store.refreshFailed).not.toHaveBeenCalled();
    expect(loaded).toEqual([provider.record.agentCardUrl, OUTCOMES_URL]);
    return { registrationId: provider.record.registrationId, retained: store.retainDuringContractDrift, stopped: store.stopNewCommerce };
  }

  it.each(["AGENT_CARD_INVALID", "CARD_CONTRACT_DRIFT"] as const)(
    "passes for each provider on the one root answer with the shared audience and both listings: %s", async (code) => {
      const answer = { providerAudience: "https://shared.example/", outcomes: executable(PROVIDERS) };
      for (const providerAgentId of PROVIDERS) {
        const run = await refresh(providerAgentId, code, answer);
        expect(run.retained).toHaveBeenCalledExactlyOnceWith(run.registrationId, code);
        expect(run.stopped).not.toHaveBeenCalled();
      }
    });

  it.each([
    ["the origin without its trailing slash", "https://shared.example"],
    ["a provider's own base", `https://shared.example/p/${PROFILE_ONLY_PROVIDER}`],
    ["a provider's own base with a slash", `https://shared.example/p/${PROFILE_ONLY_PROVIDER}/`],
  ])("fails for each provider when the root answer's audience is %s", async (_name, providerAudience) => {
    for (const providerAgentId of PROVIDERS) {
      const run = await refresh(providerAgentId, "CARD_CONTRACT_DRIFT", { providerAudience, outcomes: executable(PROVIDERS) });
      expect(run.retained).not.toHaveBeenCalled();
      expect(run.stopped).toHaveBeenCalledExactlyOnceWith(run.registrationId, "CARD_CONTRACT_DRIFT", true);
    }
  });

  it("fails for the provider whose listing the root answer does not list as executable", async () => {
    const answer = { providerAudience: "https://shared.example/", outcomes: executable([ADMITTED_PROVIDER]) };
    const listed = await refresh(ADMITTED_PROVIDER, "CARD_CONTRACT_DRIFT", answer);
    expect(listed.retained).toHaveBeenCalledExactlyOnceWith(listed.registrationId, "CARD_CONTRACT_DRIFT");
    const unlisted = await refresh(PROFILE_ONLY_PROVIDER, "CARD_CONTRACT_DRIFT", answer);
    expect(unlisted.retained).not.toHaveBeenCalled();
    expect(unlisted.stopped).toHaveBeenCalledExactlyOnceWith(unlisted.registrationId, "CARD_CONTRACT_DRIFT", true);

    const paused = { providerAudience: "https://shared.example/", outcomes: executable(PROVIDERS).map((outcome) =>
      outcome.providerAgentId === PROFILE_ONLY_PROVIDER ? { ...outcome, executable: false } : outcome) };
    expect((await refresh(PROFILE_ONLY_PROVIDER, "CARD_CONTRACT_DRIFT", paused)).retained).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// More than one control profile for a provider. A profile names one provider
// wallet, so a manifest carries two profiles for a provider that is moving
// from one wallet to another. A provider with no servicing admission is sold
// through the profile that names the agent wallet of its registration. Such a
// move keeps the provider's URLs; the added profiles here have paths of their
// own as well, so that every call shows which profile it was sent under.

describe("a provider with more than one control profile", () => {
  const NEXT_WALLET_KEY = synthetic("next provider wallet key");
  const NEXT_WALLET = privateKeyToAccount(NEXT_WALLET_KEY).address;
  const KEY_REFUSAL = "Provider control profile key is not the provider wallet";
  const PROFILE_REFUSAL = "Provider control profile is not admitted";
  type Profile = SignedEnvelope<ProviderControlProfileV1>;
  /** The provider's registration names the next wallet as its agent wallet. */
  const moved = (providerAgentId: string): StoredState => ({ agentWallets: { [providerAgentId]: NEXT_WALLET } });

  /** A further profile for a provider: a later epoch, the wallet it names, and URLs under a path of that epoch. */
  function profileAt(providerAgentId: string, servicingProfileEpoch: number, assetResponseKey: Address): Promise<Profile> {
    const { signature: _signature, payload, ...domain } = profileOf(providerAgentId);
    const urls = Object.fromEntries(ENDPOINTS.map((name) =>
      [name, payload[name].replace("/standard-rail/", `/epoch-${servicingProfileEpoch}/standard-rail/`)]),
    ) as Pick<ProviderControlProfileV1, typeof ENDPOINTS[number]>;
    return signEnvelope({
      ...domain, account: privateKeyToAccount(PRIVATE_KEYS.manifestSigner),
      payload: { ...payload, ...urls, servicingProfileEpoch, assetResponseKey },
    });
  }

  /** The committed manifest with one provider's profiles replaced, as a gateway that passed its start-up check holds it. */
  async function carrying(providerAgentId: string, profiles: Profile[]): Promise<StandardRailConfig> {
    const changed: StandardRailManifest = { ...manifest, providerControlProfiles: [
      ...manifest.providerControlProfiles.filter((profile) => profile.payload.providerAgentId !== providerAgentId),
      ...profiles,
    ] };
    at(NOW);
    await expect(startUpCheck(changed)).resolves.toBeUndefined();
    return { ...railConfig, manifest: changed };
  }

  /** The listing a provider is sold from under that manifest and stored state. */
  function listed(config: StandardRailConfig, state: StoredState = {}, providerAgentId: string = PROFILE_ONLY_PROVIDER) {
    at(NOW);
    return catalog(config, state).listing(providerAgentId, OUTCOME_ID);
  }

  /** Every call went to the profile's own URLs under its hash, and none to another profile of the provider. */
  function expectCalledAt(calls: Calls, profile: Profile, others: Profile[]) {
    const { quoteUrl, dispatchUrl, dispatchStatusUrl, lifecycleUrl } = profile.payload;
    expect(Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, call.url]))).toEqual({
      quote: quoteUrl, intake: quoteUrl, dispatch: dispatchUrl, dispatchStatus: dispatchStatusUrl, lifecycle: lifecycleUrl,
    });
    const dispatched = (calls.dispatch.body.dispatch as { payload: { providerControlProfileHash: Hex } }).payload;
    expect(dispatched.providerControlProfileHash).toBe(canonicalHash(profile));
    for (const other of others) {
      const urls = ENDPOINTS.map((name) => other.payload[name]);
      for (const call of Object.values(calls)) expect(urls).not.toContain(call.url);
      expect(dispatched.providerControlProfileHash).not.toBe(canonicalHash(other));
    }
  }

  it("is sold through the profile that names its new wallet once its registration names that wallet", async () => {
    const first = profileOf(PROFILE_ONLY_PROVIDER);
    const next = await profileAt(PROFILE_ONLY_PROVIDER, 2, NEXT_WALLET);
    const config = await carrying(PROFILE_ONLY_PROVIDER, [first, next]);

    const listing = await listed(config, moved(PROFILE_ONLY_PROVIDER));
    expect(listing.providerControlProfile).toEqual(next);
    expect(listing.commitment.payload.providerControlProfileHash).toBe(canonicalHash(next));
    expect(listing.commitment.payload.providerAuthorityKey).toBe(NEXT_WALLET);
    expect(listing.providerAgentWallet).toBe(NEXT_WALLET);
    expect(listing.runtimeCommitmentHash).toBe(registered.get(PROFILE_ONLY_PROVIDER)!.listingHash);

    // It is on sale: public and in the readiness inventory, beside the other provider on its own profile.
    at(NOW);
    const current = catalog(config, moved(PROFILE_ONLY_PROVIDER));
    const rows = await current.listOutcomes();
    expect(rows.map((row) => row.providerAgentId)).toEqual([...PROVIDERS]);
    const inventory = await current.validateCommerce(rows.map((row) => row.listingManifestHash));
    expect(inventory.map((item) => item.listingManifestHash)).toContain(listing.runtimeCommitmentHash);
    expect((await current.listing(ADMITTED_PROVIDER, OUTCOME_ID)).providerControlProfile).toEqual(profileOf(ADMITTED_PROVIDER));

    // The provider answers with its new wallet, and every call goes to the new profile's URLs.
    expectCalledAt(await callsFor(listing, NEXT_WALLET_KEY), next, [first]);
  });

  it("is still sold through its first profile while its registration names the first wallet", async () => {
    const first = profileOf(PROFILE_ONLY_PROVIDER);
    const next = await profileAt(PROFILE_ONLY_PROVIDER, 2, NEXT_WALLET);
    // The same two profiles in the other order: the wallet decides, not the place in the manifest.
    const config = await carrying(PROFILE_ONLY_PROVIDER, [next, first]);

    const listing = await listed(config);
    expect(listing.providerControlProfile).toEqual(first);
    expect(listing.commitment.payload.providerControlProfileHash).toBe(canonicalHash(first));
    expect(listing.commitment.payload.providerAuthorityKey).toBe(SHARED_WALLET);
    expectCalledAt(await callsFor(listing), first, [next]);
  });

  it("is sold through the highest epoch of several profiles that name its wallet", async () => {
    const first = profileOf(PROFILE_ONLY_PROVIDER);
    const second = await profileAt(PROFILE_ONLY_PROVIDER, 2, SHARED_WALLET);
    const third = await profileAt(PROFILE_ONLY_PROVIDER, 3, SHARED_WALLET);
    const fourth = await profileAt(PROFILE_ONLY_PROVIDER, 4, NEXT_WALLET);
    // The highest epoch for the shared wallet is neither first nor last in the manifest, nor the highest of all.
    const config = await carrying(PROFILE_ONLY_PROVIDER, [second, third, first, fourth]);

    const listing = await listed(config);
    expect(listing.providerControlProfile).toEqual(third);
    expectCalledAt(await callsFor(listing), third, [first, second, fourth]);
    expect((await listed(config, moved(PROFILE_ONLY_PROVIDER))).providerControlProfile).toEqual(fourth);
  });

  it("is not sold when none of its profiles names its wallet, with the refusals a single profile gives", async () => {
    const config = await carrying(PROFILE_ONLY_PROVIDER,
      [profileOf(PROFILE_ONLY_PROVIDER), await profileAt(PROFILE_ONLY_PROVIDER, 2, NEXT_WALLET)]);
    const elsewhere: StoredState = { agentWallets: { [PROFILE_ONLY_PROVIDER]: syntheticAddress("another wallet") } };
    await expect(listed(config, elsewhere)).rejects.toMatchObject({ message: KEY_REFUSAL });
    at(NOW);
    expect((await catalog(config, elsewhere).listOutcomes()).map((row) => row.providerAgentId)).toEqual([ADMITTED_PROVIDER]);

    // A provider the manifest carries no profile for keeps the refusal of its own.
    await expect(listed(await carrying(PROFILE_ONLY_PROVIDER, []))).rejects.toMatchObject({ message: PROFILE_REFUSAL });
  });

  it("is sold as before when it carries one profile, whatever that profile's epoch", async () => {
    const only = await profileAt(PROFILE_ONLY_PROVIDER, 5, SHARED_WALLET);
    const config = await carrying(PROFILE_ONLY_PROVIDER, [only]);

    const listing = await listed(config);
    expect(listing.providerControlProfile).toEqual(only);
    expectCalledAt(await callsFor(listing), only, [profileOf(PROFILE_ONLY_PROVIDER)]);
    await expect(listed(config, moved(PROFILE_ONLY_PROVIDER))).rejects.toMatchObject({ message: KEY_REFUSAL });
  });

  it("is sold through the profile recorded as its current one, whatever wallets and epochs its profiles name", async () => {
    const admitted = profileOf(ADMITTED_PROVIDER);
    const later = await profileAt(ADMITTED_PROVIDER, 2, SHARED_WALLET);
    const sameWallet = await carrying(ADMITTED_PROVIDER, [later, admitted]);
    // Its current admission names the first profile: a later one for the same wallet does not replace it.
    const listing = await listed(sameWallet, {}, ADMITTED_PROVIDER);
    expect(listing.providerControlProfile).toEqual(admitted);
    expectCalledAt(await callsFor(listing), admitted, [later]);
    // The later profile is the one sold through only once it is the recorded one.
    const recorded: StoredState = { currentProfileHashes: { [ADMITTED_PROVIDER]: canonicalHash(later) } };
    expect((await listed(sameWallet, recorded, ADMITTED_PROVIDER)).providerControlProfile).toEqual(later);

    // A profile for another wallet is not taken for a registration that names that wallet.
    const twoWallets = await carrying(ADMITTED_PROVIDER, [admitted, await profileAt(ADMITTED_PROVIDER, 2, NEXT_WALLET)]);
    await expect(listed(twoWallets, moved(ADMITTED_PROVIDER), ADMITTED_PROVIDER)).rejects.toMatchObject({ message: KEY_REFUSAL });
    // Nor does one replace a recorded profile the manifest does not carry.
    const missing: StoredState = {
      ...moved(ADMITTED_PROVIDER), currentProfileHashes: { [ADMITTED_PROVIDER]: synthetic("a profile the manifest does not carry") },
    };
    await expect(listed(twoWallets, missing, ADMITTED_PROVIDER)).rejects.toMatchObject({ message: PROFILE_REFUSAL });
  });

  it("keeps its first profile, as asset calls do, while it is admitted for servicing and no admission is recorded yet", async () => {
    const admitted = profileOf(ADMITTED_PROVIDER);
    const later = await profileAt(ADMITTED_PROVIDER, 2, SHARED_WALLET);
    const config = await carrying(ADMITTED_PROVIDER, [later, admitted]);
    const unrecorded: StoredState = { currentProfileHashes: { [ADMITTED_PROVIDER]: null } };
    expect((await listed(config, unrecorded, ADMITTED_PROVIDER)).providerControlProfile).toEqual(admitted);

    // Asset calls start from the same profile: the one the provider's first admission names.
    const idle = { rows: [] as unknown[] };
    const pool = {
      query: async () => idle, connect: async () => ({ query: async () => idle, release: () => undefined }),
    } as unknown as Pool;
    const assets = new StandardAssetFederation(pool, config, CHAIN_ID, {} as StandardWalletStore,
      async () => { throw new Error("no provider is called"); });
    at(NOW);
    await assets.activateAdmissions({ readOnly: true });
    expect(assets.activeServicing(ADMITTED_PROVIDER)?.listing.providerControlProfile).toEqual(admitted);

    // Meanwhile it is not sold by wallet through a profile that no admission names.
    const twoWallets = await carrying(ADMITTED_PROVIDER, [admitted, await profileAt(ADMITTED_PROVIDER, 2, NEXT_WALLET)]);
    await expect(listed(twoWallets, { ...unrecorded, ...moved(ADMITTED_PROVIDER) }, ADMITTED_PROVIDER))
      .rejects.toMatchObject({ message: KEY_REFUSAL });
  });
});
