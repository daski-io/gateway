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
// and lifecycle calls, the asset list and the retained-contract check.

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

/** The registration store as the catalog reads it, over the two registrations. */
function registrationStore(): ServiceRegistrationStore {
  const records = () => [...registered.values()].map((provider) => provider.record);
  return {
    listActiveByProvider: async (providerAgentId: string) =>
      records().filter((record) => record.providerAgentId === providerAgentId),
    listVisibleForReadiness: async () => records(),
    listPublic: async () => records(),
    registrationForListingHash: async (hash: string) =>
      [...registered.values()].find((provider) => provider.listingHash === hash)?.record ?? null,
    listingCommitments: async (ids: readonly string[]) =>
      ids.flatMap((id) => listingRows.has(id) ? [listingRows.get(id)!] : []),
    getArtifact: async () => null,
    // The servicing-admission table names a current profile for an admitted
    // provider only. Without a row the catalog takes the manifest's profile.
    currentProviderControlProfileHash: async (providerAgentId: string) =>
      providerAgentId === admission.payload.providerAgentId ? admission.payload.providerControlProfileHash : null,
  } as unknown as ServiceRegistrationStore;
}

const catalog = () => new StandardRailCatalog(
  railConfig, appConfig, registrationStore(), async () => undefined,
  { forOutcomes: async () => { throw new Error("reputation offline"); } } as unknown as DirectReputationReader,
);
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
    await expect(verifyStandardRailManifest(manifest, {
      environment: ENVIRONMENT, chainId: appConfig.chainId, gatewayAudience: railConfig.gatewayAudience,
      signers: railConfig.trustedSigners,
      splitterFactoryRuntimeCodeHash: railConfig.splitterFactoryRuntimeCodeHash,
      splitterCreationCodeHash: railConfig.splitterCreationCodeHash,
    })).resolves.toBeUndefined();
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

/** The gateway's quote, intake, dispatch, dispatch-status and lifecycle calls for one provider's listing. */
async function callsFor(listing: StandardListing): Promise<Record<"quote" | "intake" | "dispatch" | "dispatchStatus" | "lifecycle", Sent>> {
  const sent: Sent[] = [];
  const through = (answer: (request: WireRequest) => Response | Promise<Response>) => (request: WireRequest) =>
    new StandardProviderTransport((async (url: string | URL | Request) => {
      sent.push({ url: String(url), body: request.body });
      return answer(request);
    }) as typeof fetch).fetch(listing, request.url, { method: request.method, headers: request.headers, body: request.bodyText });
  const last = () => sent[sent.length - 1]!;
  const sharedWallet = privateKeyToAccount(PRIVATE_KEYS.sharedProviderWallet);
  const payer = privateKeyToAccount(WIRE_KEYS.payer).address.toLowerCase() as Hex;

  at(AT.quote);
  const quoted = await driveQuote({ listing, body: BUYER_REQUESTS.fixed, payer, respond: through(async (request) => {
    const { outcomeId, listingManifestHash, requestHash } =
      (request.body.request as { payload: { outcomeId: string; listingManifestHash: Hex; requestHash: Hex } }).payload;
    const answer = { outcomeId, listingManifestHash, requestHash, grossAmount: PRICE, payer,
      issuedAt: AT.quote, validBefore: AT.quote + 120 };
    // The provider answers with the one shared wallet, whichever provider was asked.
    return httpResponse(json(200, { ...answer,
      signature: await sharedWallet.signMessage({ message: { raw: canonicalHash(answer) } }) }));
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
