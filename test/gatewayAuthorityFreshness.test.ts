import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../src/config.js";
import type { Pool } from "../src/db/pool.js";
import { createStandardGatewayHttp } from "../src/http/gatewayApp.js";
import { ViemMarketplaceChainReader, type MarketplaceServiceRecord } from "../src/marketplace/reader.js";
import { parseProviderServiceCard } from "../src/serviceRegistration/card.js";
import * as cardFetch from "../src/serviceRegistration/cardFetch.js";
import { ViemRegistrationEvidenceVerifier } from "../src/serviceRegistration/evidence.js";
import { computeServiceId, dynamicRegistrationPolicy, prepareServiceRegistration } from "../src/serviceRegistration/preparation.js";
import { ServiceRegistrationService } from "../src/serviceRegistration/service.js";
import { ServiceRegistrationStore, type StoredRegistration } from "../src/serviceRegistration/store.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailCatalog } from "../src/standardRail/catalog.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { DirectReputationReader } from "../src/standardRail/reputationReader.js";
import { signEnvelope } from "../src/standardRail/signing.js";

// Exercise the production HTTP composition with real registration, authority,
// evidence, and catalog code, without starting unrelated settlement workers.
vi.mock("../src/standardRail/service.js", () => ({
  StandardRailService: class {
    async initialize() {}
    async stop() {}
  },
}));
vi.mock("../src/standardRail/evidence.js", () => ({ StandardChainEvidence: class {} }));

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const address = (digit: string) => `0x${digit.repeat(40)}` as Hex;
const providerKey = hash("1");
const owner = privateKeyToAccount(providerKey).address;
const agentWallet = privateKeyToAccount(hash("2")).address;
const providerAgentId = "42";
const serviceSlug = "orbital-logistics";
const serviceVersion = "1";
const serviceId = computeServiceId(providerAgentId, serviceSlug, serviceVersion);
const agentCardUrl = "https://provider.example/agent-card.json";
const registrationId = "584e61eb-ed97-4daa-bfe4-7939b5e8b6c9";
const creationCode = "0x6001600101";
const config = {
  nodeEnv: "test", trustProxy: 0, chainId: 84532, finalityTag: "safe",
  publicUrl: "https://gateway.example", mcpEnabled: false,
  dynamicServiceRegistrationEnabled: true,
  catalogOperatorToken: "catalog-operator-token-for-tests-0123456789",
  catalogRefreshIntervalMs: 240_000,
  usdc: { address: address("3") },
  marketplaceContracts: {
    identityRegistry: address("4"), agentIndex: address("5"),
    providerRegistry: address("6"), serviceRegistry: address("7"),
    validationRegistry: address("8"), reputationStorage: address("9"),
  },
} as Config;
const railConfig = {
  environment: "testnet",
  releasePrivateKey: hash("a"), dispatchPrivateKey: hash("a"),
  facilitatorBaseUrl: "https://facilitator.example",
  evidenceRpcUrls: ["https://rpc.example"],
  splitterCreationCodeHash: keccak256(creationCode),
  splitterFactoryRuntimeCodeHash: hash("b"),
  dynamicListingPolicy: {
    splitterCreationCode: creationCode, splitterFactory: address("c"),
    daskiCommissionReceiver: address("d"), commissionBps: 250,
  },
  manifest: {
    facilitatorProfile: {}, railCapabilityRequirements: {}, activeRailProfile: {},
    chainEvidencePolicy: {}, servicingAdmissions: [], actionCatalogs: [],
    providerControlProfiles: [],
  },
} as unknown as StandardRailConfig;

function rawCard(paymentRequired: boolean) {
  const schema = { type: "object", properties: {}, additionalProperties: false };
  const contract = {
    inputSchema: schema, resultSchema: schema,
    pricing: { USDC: { type: "one-time", fixed_amount: paymentRequired ? "1000000" : "0" } },
    paymentRequired, requiresAssetOwnership: false, assetType: null,
    fulfillmentMode: "automated", capacity: { maxOpenOrders: 10 },
    deadlines: { dispatchSeconds: 300 }, assetAction: null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1, serviceSlug, serviceVersion, skillId: "track-orbit", contract,
  });
  return {
    name: "Orbital Logistics", description: "Track an orbital slot.",
    extensions: {
      "https://daski.io/a2a/v1": {
        legal: {
          marketplaceTermsUrl: "https://daski.example/terms",
          marketplacePrivacyUrl: "https://daski.example/privacy",
          providerLegalName: "Orbital Logistics LLC",
          providerTermsUrl: "https://provider.example/terms",
          providerPrivacyUrl: "https://provider.example/privacy",
        },
      },
      "https://daski.io/a2a/v2": {
        schemaVersion: 1, providerAgentId,
        service: {
          serviceId, slug: serviceSlug, version: serviceVersion,
          categoryFamily: "space-operations", serviceType: "orbit-tracking",
          jurisdictions: ["global"], lifecycle: "asset-lifecycle",
          turnaroundEstimate: "instant", acceptingNewOrders: true,
        },
        standardRail: {
          origin: "https://provider.example", providerAudience: "https://provider.example/",
          quoteUrl: "https://provider.example/quote",
          dispatchUrl: "https://provider.example/dispatch",
          dispatchStatusUrl: "https://provider.example/dispatch/status",
          lifecycleUrl: "https://provider.example/lifecycle",
          assetQueryUrl: "https://provider.example/assets/query",
          assetActionUrl: "https://provider.example/assets/action",
        },
        skillContractSetHash: canonicalHash([{ skillId: "track-orbit", skillContractHash }]),
        skills: [{
          skillId: "track-orbit", skillContractHash, acceptingNewOrders: true,
          presentation: {
            name: "Track orbit", description: "Track an orbital slot.",
            examples: [], tags: ["space"], documentationUrl: "https://provider.example/docs",
          },
          contract,
        }],
      },
    },
  };
}

let server: Server | undefined;
let stopGateway: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stopGateway?.();
  stopGateway = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function setup(paymentRequired = true) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date("2026-09-04T12:00:00Z");
  vi.setSystemTime(now);
  const provider = { agentId: providerAgentId, active: true, identity: { owner, agentWallet } };
  const chainService: MarketplaceServiceRecord = {
    providerAgentId, serviceId, serviceSlug, version: serviceVersion,
    serviceUri: agentCardUrl, serviceWallet: agentWallet, active: true, createdAt: "1",
    standardReputation: {
      completed: "0", failed: "0", canceled: "0", confirmed: "0",
      notConfirmed: "0", refundedAmount: "0", transactions: "0", safeBlock: "1",
    },
  };
  const getProvider = vi.spyOn(ViemMarketplaceChainReader.prototype, "getProvider")
    .mockResolvedValue(provider);
  const getService = vi.spyOn(ViemMarketplaceChainReader.prototype, "getService")
    .mockResolvedValue(chainService);
  const raw = rawCard(paymentRequired);
  const loadCard = vi.spyOn(cardFetch, "fetchProviderCardJson").mockResolvedValue(raw);
  const card = parseProviderServiceCard(raw, {
    providerAgentId, serviceId, serviceSlug, serviceVersion, agentCardUrl,
  });
  const domain = {
    environment: "testnet", chainId: 84532, audience: config.publicUrl,
    signerKeyId: "provider-authority", privateKey: providerKey,
    issuedAt: Math.floor(now.getTime() / 1000), validBefore: Math.floor(now.getTime() / 1000) + 600,
  };
  const intent = await signEnvelope({
    ...domain, artifactType: "ProviderServiceRegistrationIntentV1",
    payload: {
      providerAgentId, serviceId, serviceSlug, serviceVersion, providerPayee: agentWallet,
      serviceContractHash: card.serviceContractHash, skillContractSetHash: card.skillContractSetHash,
      skills: card.skills.map(({ skillId, skillContractHash }) => ({ skillId, skillContractHash })),
      railPolicyHash: dynamicRegistrationPolicy(config, railConfig).policyVersionHash,
      registrationNonce: hash("e"),
    },
  });
  const prepared = await prepareServiceRegistration({
    registrationId, intent, card, agentWallet, service: chainService, config, railConfig,
  });
  const record: StoredRegistration = {
    registrationId, providerAgentId, serviceId, serviceSlug, serviceVersion, agentCardUrl,
    serviceWallet: agentWallet, providerPayee: agentWallet, providerOwner: owner,
    providerAgentWallet: agentWallet, providerSigner: owner,
    supersedesRegistrationId: null, idempotencyKey: "registration-test", requestHash: canonicalHash(intent),
    intent, prepared, card, state: "ACTIVE", marketplaceEnabled: true,
    marketplaceEnabledBy: "environment-default", marketplaceEnabledAt: now,
    cardAcceptingOrders: true, chainActive: true, registrationHealthy: true,
    evidence: null, refreshFailures: 0, lastRefreshErrorCode: null,
    lastRefreshedAt: now, lastRefreshAttemptedAt: now, activatedAt: now, createdAt: now, updatedAt: now,
  };
  const evidence = await signEnvelope({
    ...domain, artifactType: "ProviderServiceRegistrationEvidenceV1",
    payload: {
      registrationId, preparedRegistrationHash: canonicalHash(prepared),
      expectedState: "PREPARED" as const, splitterTransactionHashes: [], evidenceNonce: hash("f"),
    },
  });
  const storePrototype = ServiceRegistrationStore.prototype;
  vi.spyOn(storePrototype, "get").mockImplementation(async (id) => id === registrationId ? record : null);
  vi.spyOn(storePrototype, "getByIdempotency").mockResolvedValue(null);
  vi.spyOn(storePrototype, "getPendingByServiceId").mockResolvedValue(null);
  vi.spyOn(storePrototype, "getActiveByServiceId").mockResolvedValue(null);
  const create = vi.spyOn(storePrototype, "create").mockResolvedValue({ created: true, record });
  vi.spyOn(storePrototype, "listingCommitments").mockResolvedValue([]);
  vi.spyOn(storePrototype, "listActiveByProvider").mockResolvedValue([record]);
  const refreshed = vi.spyOn(storePrototype, "refreshed").mockImplementation(async () => {
    record.lastRefreshedAt = new Date();
  });
  const refreshFailed = vi.spyOn(storePrototype, "refreshFailed").mockResolvedValue(undefined);
  const stopNewCommerce = vi.spyOn(storePrototype, "stopNewCommerce")
    .mockImplementation(async (_id, _code, chainActive) => {
      record.registrationHealthy = false;
      record.chainActive = chainActive;
    });
  const activate = vi.spyOn(storePrototype, "activate").mockImplementation(async () => {
    record.state = "ACTIVE";
    return record;
  });
  const verify = vi.spyOn(ViemRegistrationEvidenceVerifier.prototype, "verify");
  let registrationService!: ServiceRegistrationService;
  vi.spyOn(ServiceRegistrationService.prototype, "start").mockImplementation(function (this: ServiceRegistrationService) {
    registrationService = this;
  });
  const pool = {} as Pool;
  const gateway = await createStandardGatewayHttp({
    config, standardRailConfig: railConfig, pool,
    lifecycle: { isStopping: () => false } as never,
    rateLimitStore: { consumeRateLimitBucket: async () => ({ count: 0, resetAt: now }) },
  });
  stopGateway = gateway.standardRailStop;
  server = await new Promise<Server>((resolve) => {
    const listener = gateway.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("test listener unavailable");
  const root = `http://127.0.0.1:${bound.port}`;
  // Prime the actual public router's cache before changing its live source.
  for (const path of [`providers/${providerAgentId}`, `services/${serviceId}`]) {
    const response = await fetch(`${root}/public/v2/registry/${path}`);
    expect(response.status).toBe(200);
    await response.json();
  }
  const catalog = new StandardRailCatalog(
    railConfig, config, new ServiceRegistrationStore(pool),
    (value) => registrationService.refreshRegistration(value), {} as DirectReputationReader,
  );
  return {
    record, intent, evidence, provider, chainService, getProvider, getService, loadCard,
    create, refreshed, refreshFailed, stopNewCommerce, activate, verify,
    registrationService, catalog, root, now,
  };
}

describe("gateway authority freshness", () => {
  it("accepts a current provider intent with a warm public cache", async () => {
    const test = await setup();
    await expect(test.registrationService.register(test.intent, "registration-test"))
      .resolves.toMatchObject({ created: true });
    expect(test.create).toHaveBeenCalledOnce();
  });

  it.each(["rotated", "unavailable"])("rejects an intent when cached authority is %s", async (state) => {
    const test = await setup();
    if (state === "rotated") {
      test.getProvider.mockResolvedValue({ ...test.provider, identity: { owner: address("4"), agentWallet } });
    } else {
      vi.setSystemTime(test.now.getTime() + 61_000);
      test.getProvider.mockRejectedValue(new Error("RPC_DOWN"));
    }
    await expect(test.registrationService.register(test.intent, "registration-test"))
      .rejects.toMatchObject({ code: "REGISTRATION_AUTH_INVALID" });
    expect(test.create).not.toHaveBeenCalled();
  });

  it("does not renew purchase freshness from the public cache during an RPC outage", async () => {
    const test = await setup();
    vi.setSystemTime(test.now.getTime() + 301_000);
    test.getProvider.mockRejectedValue(new Error("RPC_DOWN"));
    test.getService.mockRejectedValue(new Error("RPC_DOWN"));
    // Discovery remains available while the checkout fence fails closed.
    const discovery = await fetch(`${test.root}/public/v2/registry/services/${serviceId}`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ active: true });
    await expect(test.catalog.listing(providerAgentId, "track-orbit"))
      .rejects.toThrow("OUTCOME_NOT_FOUND");
    expect(test.refreshFailed).toHaveBeenCalledWith(registrationId, "CHAIN_AUTHORITY_UNAVAILABLE");
    expect(test.refreshed).not.toHaveBeenCalled();
    expect(test.record.lastRefreshedAt).toEqual(test.now);
    expect(test.loadCard).not.toHaveBeenCalled();
  });

  it.each(["provider inactive", "service inactive", "payee rotated", "owner rotated"])(
    "closes new commerce immediately when %s despite a warm public cache", async (state) => {
      const test = await setup();
      if (state === "provider inactive") test.getProvider.mockResolvedValue({ ...test.provider, active: false });
      if (state === "service inactive") test.getService.mockResolvedValue({ ...test.chainService, active: false });
      if (state === "payee rotated") test.getService.mockResolvedValue({ ...test.chainService, serviceWallet: address("4") });
      if (state === "owner rotated") test.getProvider.mockResolvedValue({ ...test.provider, identity: { owner: address("4"), agentWallet } });
      await test.registrationService.refreshRegistration(test.record);
      expect(test.stopNewCommerce).toHaveBeenCalledOnce();
      expect(test.refreshFailed).not.toHaveBeenCalled();
      expect(test.refreshed).not.toHaveBeenCalled();
      await expect(test.catalog.listing(providerAgentId, "track-orbit"))
        .rejects.toThrow("OUTCOME_NOT_FOUND");
    },
  );

  it("renews freshness after successful live authority and card validation", async () => {
    const test = await setup();
    vi.setSystemTime(test.now.getTime() + 301_000);
    await test.registrationService.refreshRegistration(test.record);
    expect(test.refreshed).toHaveBeenCalledOnce();
    expect(test.record.lastRefreshedAt?.getTime()).toBe(Date.now());
    expect(test.refreshFailed).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "deactivated", "authority rotated", "current"])(
    "verifies pending activation against %s live state, not public cached state", async (state) => {
      const test = await setup(false);
      test.record.state = "EVIDENCE_PENDING";
      test.record.evidence = test.evidence;
      vi.setSystemTime(test.now.getTime() + 61_000);
      if (state === "unavailable") test.getService.mockRejectedValue(new Error("RPC_DOWN"));
      if (state === "deactivated") test.getService.mockResolvedValue({ ...test.chainService, active: false });
      if (state === "authority rotated") test.getProvider.mockResolvedValue({ ...test.provider, identity: { owner: address("4"), agentWallet } });
      await test.registrationService.submitEvidence(registrationId, test.evidence);
      await test.registrationService.settleEvidenceVerification(registrationId);
      expect(test.verify).toHaveBeenCalledOnce();
      if (state === "current") {
        expect(test.activate).toHaveBeenCalledOnce();
      } else {
        await expect(test.verify.mock.results[0]!.value).rejects.toThrow();
        expect(test.activate).not.toHaveBeenCalled();
        expect(test.record.state).toBe("EVIDENCE_PENDING");
      }
    },
  );

  it("rechecks live authority after splitter evidence verification", async () => {
    const test = await setup(false);
    test.record.state = "EVIDENCE_PENDING";
    test.record.evidence = test.evidence;
    test.verify.mockImplementation(async () => {
      test.getProvider.mockRejectedValue(new Error("RPC_DOWN"));
      return new Map();
    });
    await test.registrationService.submitEvidence(registrationId, test.evidence);
    await test.registrationService.settleEvidenceVerification(registrationId);
    expect(test.activate).not.toHaveBeenCalled();
    expect(test.record.state).toBe("EVIDENCE_PENDING");
  });
});
