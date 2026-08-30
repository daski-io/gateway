import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { StandardRailCatalog } from "../src/standardRail/catalog.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { DirectReputationReader } from "../src/standardRail/reputationReader.js";
import { buildRuntimeListingCommitment } from "../src/serviceRegistration/runtimeCommitment.js";
import type {
  ServiceRegistrationStore,
  StoredRegistration,
} from "../src/serviceRegistration/store.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const address = (byte: string): Hex => `0x${byte.repeat(40)}` as Hex;

const providerAgentId = "8327";
const serviceId = hash("2");
const listingId = "5e0f95a6-3f9f-4bb0-9a68-59f2e26bde33";
const listingKey = hash("3");
const splitterAddress = address("5");
const providerPayee = address("3");
const providerWallet = address("2");
const providerOwner = address("9");

const preparationEnvelope = {
  artifactType: "GatewayListingPreparationV1",
  schemaVersion: 1,
  environment: "testnet",
  chainId: 84532,
  audience: "https://gateway.example.test",
  signerKeyId: "gateway-protocol",
  issuedAt: 1,
  validBefore: 2_000_000_000,
  payload: {
    registrationId: "reg-1",
    listingId,
    listingKey,
    providerAgentId,
    serviceId,
    serviceSlug: "domain-registration",
    serviceVersion: "1.0.0",
    skillId: "register-domain",
    skillContractHash: hash("7"),
    skillContractSetHash: hash("8"),
    providerIntentHash: hash("6"),
    canonicalToken: address("a"),
    providerPayee,
    daskiCommissionReceiver: address("4"),
    commissionBps: 250,
    splitterFactory: address("b"),
    splitterDeploymentSalt: hash("c"),
    policyVersionHash: hash("d"),
    listingEpoch: "1",
  },
  signature: `0x${"e".repeat(130)}`,
} as never;

const controlProfileEnvelope = {
  artifactType: "ProviderControlProfileV1",
  schemaVersion: 1,
  environment: "testnet",
  chainId: 84532,
  audience: "https://gateway.example.test",
  signerKeyId: "gateway-protocol",
  issuedAt: 1,
  validBefore: 2_000_000_000,
  payload: {
    providerAgentId,
    providerAudience: "https://provider.example.test",
    origin: "https://provider.example.test/",
    quoteUrl: "https://provider.example.test/standard-rail/quote",
    dispatchUrl: "https://provider.example.test/standard-rail/dispatch",
    dispatchStatusUrl: "https://provider.example.test/standard-rail/dispatch/status",
    lifecycleUrl: "https://provider.example.test/standard-rail/lifecycle",
    assetQueryUrl: "https://provider.example.test/standard-rail/assets/query",
    assetActionUrl: "https://provider.example.test/standard-rail/assets/action",
    assetResponseKeyId: "provider-wallet",
    assetResponseKey: providerWallet,
    servicingProfileEpoch: 1,
    tlsPolicy: "webpki-v1",
    workloadAuthentication: "signed-envelopes-v1",
    maxResponseBytes: 524_288,
    timeoutMs: 90_000,
  },
  signature: `0x${"f".repeat(130)}`,
} as never;

const runtimeCommitment = buildRuntimeListingCommitment({
  environment: "testnet",
  chainId: 84532,
  gatewayAudience: "https://gateway.example.test",
  providerAgentId,
  serviceId,
  currentProviderIntentHash: hash("6"),
  currentProviderPayee: providerPayee,
  policy: {
    canonicalToken: address("a"),
    daskiCommissionReceiver: address("4"),
    commissionBps: 250,
    policyVersionHash: hash("d"),
    splitterFactory: address("b"),
  },
  listing: {
    listingId,
    listingKey,
    skillId: "register-domain",
    skillContractHash: hash("7"),
    paymentRequired: true,
    splitterAddress,
    preparation: preparationEnvelope,
    controlProfile: null,
  },
});
const runtimeCommitmentHash = canonicalHash(
  runtimeCommitment as unknown as Record<string, unknown>,
) as Hex;

const checkpoint = {
  splitterDeploymentTransactionHash: hash("a"),
  splitterDeploymentBlockNumber: "100",
  splitterDeploymentBlockHash: hash("b"),
  splitterRuntimeCodeHash: hash("c"),
  splitterActivationBlockNumber: "100",
  splitterActivationBlockHash: hash("b"),
  splitterActivationPosition: "END_OF_BLOCK",
  splitterStartingTokenBalance: "0",
  splitterStartingReleaseSequence: "0",
};

function closedSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { domainName: { type: "string" } },
    required: ["domainName"],
    additionalProperties: false,
    maxProperties: 1,
  };
}

function skill(overrides: Record<string, unknown> = {}) {
  return {
    skillId: "register-domain",
    skillContractHash: hash("7"),
    acceptingNewOrders: true,
    presentation: {
      name: "Register a domain",
      description: "Registers a domain name.",
      examples: [],
      tags: ["domains"],
      documentationUrl: "https://provider.example.test/docs",
    },
    contract: {
      inputSchema: closedSchema(),
      resultSchema: closedSchema(),
      pricing: { USDC: { type: "one-time", fixed_amount: "5000000" } },
      paymentRequired: true,
      requiresAssetOwnership: false,
      assetType: "domain",
      fulfillmentMode: "automated",
      capacity: { maxOpenOrders: 10 },
      deadlines: { dispatchSeconds: 300 },
      assetAction: null,
    },
    ...overrides,
  };
}

function record(overrides: Partial<StoredRegistration> = {}): StoredRegistration {
  const card = {
    name: "Domain Registration",
    description: "Registers domains for agents.",
    providerAgentId,
    service: {
      serviceId,
      slug: "domain-registration",
      version: "1.0.0",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
      jurisdictions: ["global"],
      lifecycle: "available",
      turnaroundEstimate: "PT1H",
      acceptingNewOrders: true,
    },
    standardRail: {
      origin: "https://provider.example.test/",
      providerAudience: "https://provider.example.test",
      quoteUrl: "https://provider.example.test/standard-rail/quote",
      dispatchUrl: "https://provider.example.test/standard-rail/dispatch",
      dispatchStatusUrl: "https://provider.example.test/standard-rail/dispatch/status",
      lifecycleUrl: "https://provider.example.test/standard-rail/lifecycle",
      assetQueryUrl: "https://provider.example.test/standard-rail/assets/query",
      assetActionUrl: "https://provider.example.test/standard-rail/assets/action",
    },
    legal: {
      marketplaceTermsUrl: "https://daski.io/terms-of-use",
      marketplacePrivacyUrl: "https://daski.io/privacy-policy",
      providerLegalName: "Blue T Group, LLC",
      providerTermsUrl: "https://provider.example.test/terms",
      providerPrivacyUrl: "https://provider.example.test/privacy",
    },
    serviceContractHash: hash("1"),
    skillContractSetHash: hash("8"),
    skills: [skill()],
  };
  return {
    registrationId: "reg-1",
    providerAgentId,
    serviceId,
    serviceSlug: "domain-registration",
    serviceVersion: "1.0.0",
    supersedesRegistrationId: null,
    agentCardUrl: "https://provider.example.test/.well-known/agent.json",
    serviceWallet: providerPayee,
    idempotencyKey: "key-1",
    providerPayee,
    providerOwner,
    providerAgentWallet: providerWallet,
    providerSigner: providerWallet,
    requestHash: hash("9"),
    intent: {} as never,
    prepared: {
      registrationId: "reg-1",
      state: "ACTIVE",
      providerAgentId,
      serviceId,
      serviceSlug: "domain-registration",
      serviceVersion: "1.0.0",
      agentCardUrl: "https://provider.example.test/.well-known/agent.json",
      serviceWallet: providerPayee,
      providerPayee,
      providerIntentHash: hash("6"),
      railPolicyHash: hash("d"),
      marketplaceEnabled: true,
      listings: [{
        listingId,
        listingKey,
        skillId: "register-domain",
        skillContractHash: hash("7"),
        paymentRequired: true,
        acceptingNewOrders: true,
        deploymentRequired: true,
        reused: false,
        splitterAddress,
        preparation: preparationEnvelope,
        controlProfile: null,
        transaction: null,
      }],
    },
    card: card as never,
    state: "ACTIVE",
    marketplaceEnabled: true,
    marketplaceEnabledBy: "environment-default",
    marketplaceEnabledAt: new Date(),
    cardAcceptingOrders: true,
    chainActive: true,
    evidence: null,
    registrationHealthy: true,
    refreshFailures: 0,
    lastRefreshErrorCode: null,
    lastRefreshedAt: new Date(),
    activatedAt: new Date(),
    lastRefreshAttemptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeStoreState {
  records: StoredRegistration[];
  rows: Map<string, {
    listingId: string;
    state: string;
    acceptingNewOrders: boolean;
    runtimeCommitmentHash: Hex | null;
    runtimeCommitment: unknown;
    activationCheckpoint: unknown;
    splitterTransactionHash: Hex | null;
  }>;
  refreshes: number;
  onRefresh?: (state: FakeStoreState) => void;
}

function fakeState(records: StoredRegistration[]): FakeStoreState {
  return {
    records,
    rows: new Map([[listingId, {
      listingId,
      state: "ACTIVE",
      acceptingNewOrders: true,
      runtimeCommitmentHash,
      runtimeCommitment,
      activationCheckpoint: checkpoint,
      splitterTransactionHash: hash("a"),
    }]]),
    refreshes: 0,
  };
}

function catalogFor(state: FakeStoreState): StandardRailCatalog {
  const store = {
    listActiveByProvider: async (agent: string) =>
      state.records.filter((item) =>
        item.providerAgentId === agent && item.state === "ACTIVE"),
    listPublic: async () => state.records.filter((item) =>
      item.state === "ACTIVE" && item.marketplaceEnabled && item.cardAcceptingOrders &&
      item.chainActive && item.registrationHealthy),
    listingCommitments: async (ids: readonly string[]) =>
      ids.map((id) => state.rows.get(id)).filter(Boolean),
    getArtifact: async () => null,
    get: async (id: string) =>
      state.records.find((item) => item.registrationId === id) ?? null,
  } as unknown as ServiceRegistrationStore;
  const railConfig = {
    environment: "testnet",
    screeningPolicy: {
      sanctionsOracle: address("d"),
      sanctionsOracleRuntimeCodeHash: hash("e"),
    },
    manifest: {
      facilitatorProfile: { artifactType: "FacilitatorProfileV1" },
      railCapabilityRequirements: { artifactType: "RailCapabilityRequirementsV1" },
      activeRailProfile: { artifactType: "ActiveRailProfileV1" },
      chainEvidencePolicy: { artifactType: "ChainEvidencePolicyV2" },
      servicingAdmissions: [],
      actionCatalogs: [],
      providerControlProfiles: [controlProfileEnvelope],
    },
  } as unknown as StandardRailConfig;
  return new StandardRailCatalog(
    railConfig,
    { chainId: 84532, publicUrl: "https://gateway.example.test" } as never,
    store,
    async () => {
      state.refreshes += 1;
      state.onRefresh?.(state);
    },
    {
      forOutcomes: async () => { throw new Error("reputation offline"); },
    } as unknown as DirectReputationReader,
  );
}

describe("dynamic listing catalog", () => {
  it("assembles a purchasable listing with the Option A v2 deal slots", async () => {
    const catalog = catalogFor(fakeState([record()]));
    const listing = await catalog.listing(providerAgentId, "register-domain");

    expect(listing.runtimeCommitmentHash).toBe(runtimeCommitmentHash);
    expect(listing.providerIntentHash).toBe(hash("6"));
    expect(listing.commitment.payload.bindingProfile).toBe("recipe-bound-v2");
    expect(listing.commitment.payload.outcomeId).toBe("register-domain");
    expect(listing.commitment.payload.providerAuthorityKey.toLowerCase())
      .toBe(providerWallet.toLowerCase());
    expect(listing.commitment.payload.commissionBps).toBe(250);
    expect(listing.manifest.payload.splitterAddress.toLowerCase())
      .toBe(splitterAddress.toLowerCase());
    expect(listing.manifest.payload.listingCommitmentHash)
      .toBe(canonicalHash(preparationEnvelope));
    expect(listing.manifest.payload.outcomeIdHash).toBe(listingKey);
    expect(listing.offer.payload.pricingMode).toBe("fixed");
    expect(listing.offer.payload.fixedGrossAmount).toBe("5000000");
    expect(listing.quotePolicy).toBeNull();
    expect(listing.deadlinePolicy.dispatchSeconds).toBe(300);
    expect(listing.capacityPolicy.maxOpenOrders).toBe(10);
    expect(listing.screeningPolicy.policyId).toBe("daski-testnet-screening-v1");
    expect(listing.terms.providerLegalName).toBe("Blue T Group, LLC");
  });

  it("refreshes once and re-reads when the §10 purchase fence is stale", async () => {
    const stale = record({ lastRefreshedAt: new Date(Date.now() - 10 * 60_000) });
    const state = fakeState([stale]);
    state.onRefresh = (current) => {
      current.records = [record()];
    };
    const catalog = catalogFor(state);

    const listing = await catalog.listing(providerAgentId, "register-domain");
    expect(state.refreshes).toBe(1);
    expect(listing.runtimeCommitmentHash).toBe(runtimeCommitmentHash);
  });

  it("refuses the purchase when the fence stays stale after the refresh", async () => {
    const stale = record({ lastRefreshedAt: new Date(Date.now() - 10 * 60_000) });
    const state = fakeState([stale]);
    const catalog = catalogFor(state);

    await expect(catalog.listing(providerAgentId, "register-domain"))
      .rejects.toThrow("OUTCOME_NOT_FOUND");
    expect(state.refreshes).toBe(1);
  });

  it("closes the listing when the card republishes a changed skill contract", async () => {
    const drifted = record();
    (drifted.card as { skills: unknown[] }).skills =
      [skill({ skillContractHash: hash("f") })];
    const catalog = catalogFor(fakeState([drifted]));

    await expect(catalog.listing(providerAgentId, "register-domain"))
      .rejects.toThrow("drifted from its admitted version");
    expect(await catalog.publicOutcomes()).toEqual([]);
  });

  it("hides a listing whose marketplace visibility is off", async () => {
    const hidden = record({ marketplaceEnabled: false });
    const catalog = catalogFor(fakeState([hidden]));

    await expect(catalog.listing(providerAgentId, "register-domain"))
      .rejects.toThrow("OUTCOME_NOT_FOUND");
  });

  it("fails closed on a corrupt runtime commitment preimage", async () => {
    const state = fakeState([record()]);
    const row = state.rows.get(listingId)!;
    row.runtimeCommitment = { ...(runtimeCommitment as object), commissionBps: 9_999 };
    const catalog = catalogFor(state);

    await expect(catalog.listing(providerAgentId, "register-domain"))
      .rejects.toThrow("corrupt");
  });

  it("serves public rows carrying the v2 slots and card presentation", async () => {
    const catalog = catalogFor(fakeState([record()]));
    const rows = await catalog.publicOutcomes();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.listingManifestHash).toBe(runtimeCommitmentHash);
    expect(row.providerOfferHash).toBe(hash("6"));
    expect(row.runtimeCommitmentHash).toBe(runtimeCommitmentHash);
    expect(row.providerIntentHash).toBe(hash("6"));
    expect(row.bindingProfile).toBe("recipe-bound-v2");
    expect(row.splitter).toEqual({
      splitterAddress,
      splitterFactory: getAddress(address("b")),
      splitterDeploymentTransaction: checkpoint.splitterDeploymentTransactionHash,
      splitterDeploymentBlockNumber: checkpoint.splitterDeploymentBlockNumber,
      splitterDeploymentBlockHash: checkpoint.splitterDeploymentBlockHash,
      splitterRuntimeCodeHash: checkpoint.splitterRuntimeCodeHash,
      splitterActivationBlockNumber: checkpoint.splitterActivationBlockNumber,
      splitterActivationBlockHash: checkpoint.splitterActivationBlockHash,
      splitterActivationPosition: checkpoint.splitterActivationPosition,
      splitterStartingTokenBalance: checkpoint.splitterStartingTokenBalance,
      splitterStartingReleaseSequence: checkpoint.splitterStartingReleaseSequence,
      outcomeIdHash: listingKey,
      listingCommitmentHash: canonicalHash(preparationEnvelope),
      policyVersionHash: hash("d"),
      listingEpoch: "1",
    });
    expect(row).not.toHaveProperty("fulfillmentObligationHash");
    expect(row).not.toHaveProperty("jurisdictionObligationHashes");
    expect((row.service as { name: string }).name).toBe("Domain Registration");
    expect((row.skill as { name: string }).name).toBe("Register a domain");
    expect(row.pricingMode).toBe("fixed");
    expect(row.persistentAsset).toBe(true);
    expect(row.absoluteResourceUri)
      .toBe(`https://gateway.example.test/outcomes/${providerAgentId}/register-domain`);
  });

  it("excludes a skill whose availability is paused without touching its siblings", async () => {
    const paused = record();
    (paused.card as { skills: unknown[] }).skills = [skill({ acceptingNewOrders: false })];
    const catalog = catalogFor(fakeState([paused]));

    await expect(catalog.listing(providerAgentId, "register-domain"))
      .rejects.toThrow("OUTCOME_NOT_FOUND");
    expect(await catalog.publicOutcomes()).toEqual([]);
  });
});

describe("outcome search", () => {
  function catalogWithJurisdictions(jurisdictions: string[]): StandardRailCatalog {
    const row = record();
    (row.card as { service: { jurisdictions: string[] } }).service.jurisdictions =
      jurisdictions;
    return catalogFor(fakeState([row]));
  }

  it("requires every text token to match names, descriptions, or tags", async () => {
    const catalog = catalogFor(fakeState([record()]));
    expect(await catalog.searchOutcomes({ text: "domain registers", limit: 10 }))
      .toHaveLength(1);
    expect(await catalog.searchOutcomes({ text: "domain llc", limit: 10 }))
      .toHaveLength(0);
  });

  it("serves a country listing to its subdivision filter and back", async () => {
    const country = catalogWithJurisdictions(["US"]);
    expect(await country.searchOutcomes({ jurisdiction: "US-WY", limit: 10 }))
      .toHaveLength(1);
    expect(await country.searchOutcomes({ jurisdiction: "US", limit: 10 }))
      .toHaveLength(1);
    expect(await country.searchOutcomes({ jurisdiction: "DE", limit: 10 }))
      .toHaveLength(0);

    const subdivision = catalogWithJurisdictions(["US-WY"]);
    expect(await subdivision.searchOutcomes({ jurisdiction: "US", limit: 10 }))
      .toHaveLength(1);
    expect(await subdivision.searchOutcomes({ jurisdiction: "US-DE", limit: 10 }))
      .toHaveLength(0);
  });

  it("serves a global listing to every jurisdiction filter", async () => {
    const catalog = catalogWithJurisdictions(["global"]);
    expect(await catalog.searchOutcomes({ jurisdiction: "US-WY", limit: 10 }))
      .toHaveLength(1);
    expect(await catalog.searchOutcomes({ jurisdiction: "global", limit: 10 }))
      .toHaveLength(1);
  });

  it("returns compact rows without splitter, policies, or purchase history", async () => {
    const catalog = catalogFor(fakeState([record()]));
    const rows = await catalog.searchOutcomes({ limit: 10 });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).not.toHaveProperty("splitter");
    expect(row).not.toHaveProperty("deadlinePolicy");
    expect(row).not.toHaveProperty("capacityPolicy");
    expect(row).not.toHaveProperty("reputation");
    expect(row.providerReputation).not.toHaveProperty("recentPurchases");
    expect(row.serviceReputation).not.toHaveProperty("recentPurchases");
    expect(row.skill.description).toBe("Registers a domain name.");
    expect(row.terms.providerLegalName).toBe("Blue T Group, LLC");
    expect(row.absoluteResourceUri)
      .toBe(`https://gateway.example.test/outcomes/${providerAgentId}/register-domain`);
  });

  it("drops the duplicated service reputation block from full public rows", async () => {
    const catalog = catalogFor(fakeState([record()]));
    const rows = await catalog.publicOutcomes();

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("reputation");
    expect(rows[0]).toHaveProperty("serviceReputation");
    expect(rows[0]).toHaveProperty("splitter");
  });

  it("serves the live catalog vocabulary for zero-hit steering", async () => {
    const catalog = catalogFor(fakeState([record()]));
    const vocabulary = await catalog.searchVocabulary();

    expect(vocabulary.categoryFamilies).toEqual(["domains-web"]);
    expect(vocabulary.serviceTypes).toEqual(["domain-management"]);
    expect(vocabulary.jurisdictions).toEqual(["global"]);
    expect(vocabulary.note).toContain("ISO 3166");
  });
});
