import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { ServiceRegistrationStore } from "../src/serviceRegistration/store.js";
import type {
  PreparedListing,
  PreparedServiceRegistration,
  ProviderServiceCard,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentEnvelope,
} from "../src/serviceRegistration/types.js";
import { canonicalHash } from "../src/standardRail/canonical.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const serviceId = hash("1");
const providerPayee = address("2");
const serviceWallet = address("3");
const now = Math.floor(Date.now() / 1_000);

function envelope<T>(artifactType: string, payload: T) {
  return {
    artifactType,
    schemaVersion: 1 as const,
    environment: "testnet",
    chainId: 84_532,
    audience: "https://gateway.example",
    signerKeyId: "provider-authority",
    issuedAt: now,
    validBefore: now + 3_600,
    payload,
    signature: `0x${"00".repeat(65)}` as Hex,
  };
}

function intent(nonceDigit: string): ProviderServiceRegistrationIntentEnvelope {
  return envelope("ProviderServiceRegistrationIntentV1", {
    providerAgentId: "42",
    serviceId,
    serviceSlug: "orbital-logistics",
    serviceVersion: "1",
    providerPayee,
    serviceContractHash: hash("c"),
    skillContractSetHash: hash("4"),
    skills: [{ skillId: "track-orbit", skillContractHash: hash("5") }],
    railPolicyHash: hash("6"),
    registrationNonce: hash(nonceDigit),
  }) as ProviderServiceRegistrationIntentEnvelope;
}

function card(name: string): ProviderServiceCard {
  return {
    name,
    description: "Track an orbital slot.",
    providerAgentId: "42",
    service: {
      serviceId,
      slug: "orbital-logistics",
      version: "1",
      categoryFamily: "space-operations",
      serviceType: "orbit-tracking",
      jurisdictions: ["LEO"],
      lifecycle: "asset-lifecycle",
      turnaroundEstimate: "instant",
      acceptingNewOrders: true,
    },
    standardRail: {
      origin: "https://provider.example",
      providerAudience: "https://provider.example/",
      quoteUrl: "https://provider.example/standard-rail/quote",
      dispatchUrl: "https://provider.example/standard-rail/dispatch",
      dispatchStatusUrl: "https://provider.example/standard-rail/dispatch/status",
      lifecycleUrl: "https://provider.example/standard-rail/lifecycle",
      assetQueryUrl: "https://provider.example/standard-rail/assets/query",
      assetActionUrl: "https://provider.example/standard-rail/assets/action",
    },
    legal: {
      marketplaceTermsUrl: "https://daski.example/terms",
      marketplacePrivacyUrl: "https://daski.example/privacy",
      providerLegalName: "Orbital Logistics LLC",
      providerTermsUrl: "https://provider.example/terms",
      providerPrivacyUrl: "https://provider.example/privacy",
    },
    serviceContractHash: hash("c"),
    skillContractSetHash: hash("4"),
    skills: [{
      skillId: "track-orbit",
      skillContractHash: hash("5"),
      acceptingNewOrders: true,
      presentation: {
        name: "Track orbit",
        description: "Track an orbital slot.",
        examples: ["Track LEO-17"],
        tags: ["space"],
        documentationUrl: "https://provider.example/skills/track-orbit.md",
      },
      contract: {
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        resultSchema: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
          additionalProperties: false,
        },
        pricing: { USDC: { type: "one-time", fixed_amount: "0" } },
        paymentRequired: false,
        requiresAssetOwnership: false,
        assetType: null,
        fulfillmentMode: "automated", purchaseReadiness: null,
        capacity: { maxOpenOrders: 100 },
        deadlines: { dispatchSeconds: 30 },
        assetAction: null,
      },
    }],
  };
}

function prepared(args: {
  registrationId: string;
  reused: boolean;
}): PreparedServiceRegistration {
  return {
    registrationId: args.registrationId,
    state: "PREPARED",
    providerAgentId: "42",
    serviceId,
    serviceSlug: "orbital-logistics",
    serviceVersion: "1",
    agentCardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
    serviceWallet,
    providerPayee,
    providerIntentHash: hash("7"),
    railPolicyHash: hash("6"),
    marketplaceEnabled: true,
    listings: [{
      listingId: randomUUID(),
      listingKey: hash("8"),
      skillId: "track-orbit",
      skillContractHash: hash("5"),
      paymentRequired: false,
      acceptingNewOrders: true,
      deploymentRequired: false,
      reused: args.reused,
      splitterAddress: null,
      preparation: null,
      controlProfile: null,
      transaction: null,
    }],
  };
}

function evidence(
  registration: PreparedServiceRegistration,
  nonceDigit: string,
): ProviderServiceRegistrationEvidenceEnvelope {
  return envelope("ProviderServiceRegistrationEvidenceV1", {
    registrationId: registration.registrationId,
    preparedRegistrationHash: canonicalHash(registration),
    expectedState: "PREPARED",
    splitterTransactionHashes: [],
    evidenceNonce: hash(nonceDigit),
  }) as ProviderServiceRegistrationEvidenceEnvelope;
}

describe("dynamic service registration storage", () => {
  it("activates revisions atomically, preserves visibility, and supersedes history", async () => {
    const schema = `service_registration_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({
      connectionString: databaseUrl,
      searchPath: `${schema},public`,
      max: 2,
    });
    try {
      await runMigrations(pool);
      const store = new ServiceRegistrationStore(pool);
      const firstIntent = intent("9");
      const firstCard = card("Orbital Logistics");
      const firstPrepared = prepared({
        registrationId: randomUUID(),
        reused: false,
      });
      const firstArgs = {
        intent: firstIntent,
        requestHash: canonicalHash(firstIntent),
        idempotencyKey: "register-orbit-v1",
        serviceId,
        card: firstCard,
        cardHash: canonicalHash(firstCard),
        prepared: firstPrepared,
        providerOwner: address("a"),
        providerAgentWallet: address("b"),
        providerSigner: address("a"),
        supersedesRegistrationId: null,
      };
      expect((await store.create(firstArgs)).created).toBe(true);
      expect((await store.create(firstArgs)).created).toBe(false);

      const firstEvidence = evidence(firstPrepared, "a");
      await store.recordEvidencePending({
        registrationId: firstPrepared.registrationId,
        evidence: firstEvidence,
      });
      await expect(store.recordEvidencePending({
        registrationId: firstPrepared.registrationId,
        evidence: firstEvidence,
      })).resolves.toMatchObject({ state: "EVIDENCE_PENDING" });
      await expect(store.recordEvidencePending({
        registrationId: firstPrepared.registrationId,
        evidence: evidence(firstPrepared, "d"),
      })).rejects.toThrow("REGISTRATION_STATE_CONFLICT");
      expect(await store.get(firstPrepared.registrationId)).toMatchObject({
        evidence: firstEvidence,
      });

      await store.activate(firstPrepared.registrationId, [{
        listingId: firstPrepared.listings[0]!.listingId,
        runtimeCommitmentHash: hash("d"),
        runtimeCommitment: { artifactType: "RuntimeListingCommitmentV1" },
      }]);
      expect(await store.getActiveByServiceId(serviceId)).toMatchObject({
        registrationId: firstPrepared.registrationId,
        marketplaceEnabled: true,
        state: "ACTIVE",
      });
      expect(await store.listingCommitments([firstPrepared.listings[0]!.listingId]))
        .toMatchObject([{
          listingId: firstPrepared.listings[0]!.listingId,
          runtimeCommitmentHash: hash("d"),
        }]);

      const secondIntent = intent("b");
      const secondCard = card("Orbital Logistics, refreshed");
      const secondPrepared = prepared({
        registrationId: randomUUID(),
        reused: true,
      });
      // Real reuse retains the prior listing verbatim (same listing id and
      // artifacts); its row stays under the first registration.
      secondPrepared.listings[0] = { ...firstPrepared.listings[0]!, reused: true };
      await store.create({
        intent: secondIntent,
        requestHash: canonicalHash(secondIntent),
        idempotencyKey: "register-orbit-v2",
        serviceId,
        card: secondCard,
        cardHash: canonicalHash(secondCard),
        prepared: secondPrepared,
        providerOwner: address("a"),
        providerAgentWallet: address("b"),
        providerSigner: address("a"),
        supersedesRegistrationId: firstPrepared.registrationId,
      });
      await store.recordEvidencePending({
        registrationId: secondPrepared.registrationId,
        evidence: evidence(secondPrepared, "c"),
      });
      // A reused listing must arrive with its original commitment hash; a
      // different hash would mean the sibling change rotated its identity.
      await expect(store.activate(secondPrepared.registrationId, [{
        listingId: secondPrepared.listings[0]!.listingId,
        runtimeCommitmentHash: hash("e"),
        runtimeCommitment: { artifactType: "RuntimeListingCommitmentV1" },
      }])).rejects.toThrow(/RUNTIME_COMMITMENT_LISTING_MISMATCH/);
      // Rejection occurs after the old registration would have been marked
      // superseded; the transaction must leave its serving state intact.
      expect(await store.getActiveByServiceId(serviceId)).toMatchObject({
        registrationId: firstPrepared.registrationId, state: "ACTIVE", marketplaceEnabled: true,
      });
      expect(await store.get(secondPrepared.registrationId)).toMatchObject({ state: "EVIDENCE_PENDING" });
      const priorCheckpoint = { safeBlock: "100", runtimeHash: hash("d") };
      await expect(store.activate(secondPrepared.registrationId, [{
        listingId: firstPrepared.listings[0]!.listingId,
        runtimeCommitmentHash: hash("d"),
        runtimeCommitment: { artifactType: "RuntimeListingCommitmentV1" },
      }], [{ listingId: randomUUID(), checkpoint: priorCheckpoint }]))
        .rejects.toThrow("ACTIVATION_CHECKPOINT_MISMATCH");
      expect(await store.getActiveByServiceId(serviceId)).toMatchObject({
        registrationId: firstPrepared.registrationId, state: "ACTIVE",
      });
      await store.activate(secondPrepared.registrationId, [{
        listingId: secondPrepared.listings[0]!.listingId,
        runtimeCommitmentHash: hash("d"),
        runtimeCommitment: { artifactType: "RuntimeListingCommitmentV1" },
      }]);

      expect(await store.get(firstPrepared.registrationId)).toMatchObject({
        state: "SUPERSEDED",
        marketplaceEnabled: false,
      });
      expect(await store.getActiveByServiceId(serviceId)).toMatchObject({
        registrationId: secondPrepared.registrationId,
        state: "ACTIVE",
        marketplaceEnabled: true,
      });

      const rejectedIntent = intent("e");
      const rejectedCard = card("Orbital Logistics, rejected drift");
      const rejectedPrepared = prepared({
        registrationId: randomUUID(),
        reused: true,
      });
      await store.create({
        intent: rejectedIntent,
        requestHash: canonicalHash(rejectedIntent),
        idempotencyKey: "register-orbit-rejected",
        serviceId,
        card: rejectedCard,
        cardHash: canonicalHash(rejectedCard),
        prepared: rejectedPrepared,
        providerOwner: address("a"),
        providerAgentWallet: address("b"),
        providerSigner: address("a"),
        supersedesRegistrationId: secondPrepared.registrationId,
      });
      expect(await store.rejectPending(
        rejectedPrepared.registrationId,
        "PREPARED_REGISTRATION_DRIFT",
      )).toBe(true);
      expect(await store.get(rejectedPrepared.registrationId)).toMatchObject({
        state: "REJECTED",
        lastRefreshErrorCode: "PREPARED_REGISTRATION_DRIFT",
      });
      expect(await store.getPendingByServiceId(serviceId)).toBeNull();
      expect((await store.listPublic(10)).map((item) => item.registrationId))
        .toEqual([secondPrepared.registrationId]);
      // Hidden means operator visibility, including unhealthy registrations;
      // superseded and rejected history must never be offered for restoration.
      expect(await store.listOperator(true, 100, null)).toEqual([]);
      await store.setVisibility(secondPrepared.registrationId, false, "catalog-operator");
      await store.stopNewCommerce(secondPrepared.registrationId, "temporarily_unavailable", false);
      const hidden = await store.listOperator(true, 100, null);
      expect(hidden.map((item) => item.registrationId)).toEqual([secondPrepared.registrationId]);
      expect(hidden[0]).toMatchObject({ marketplaceEnabled: false, marketplaceEnabledBy: "catalog-operator" });
      expect(await store.listOperator(true, 100, secondPrepared.registrationId)).toEqual([]);
      expect(await store.listOperator(false, 100, null)).toEqual([]);
      await store.setVisibility(secondPrepared.registrationId, true, "catalog-operator");
      expect(await store.listOperator(true, 100, null)).toEqual([]);
      expect((await store.listOperator(false, 100, null)).map((item) => item.registrationId))
        .toEqual([secondPrepared.registrationId]);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);
});

// Cross-replica visibility and activation-fence invariants.
describe("release-safe registration handover", () => {
  async function isolated(work: (store: ServiceRegistrationStore) => Promise<void>) {
    const schema = `release_registration_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 4 });
    try {
      await runMigrations(pool);
      await work(new ServiceRegistrationStore(pool));
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`);
      await bootstrap.end();
    }
  }
  async function successor(store: ServiceRegistrationStore, revision: number, nonce: string, supersedes: string | null = null) {
    const signed = intent(nonce);
    (signed.payload as typeof signed.payload & { targetRevision: number }).targetRevision = revision;
    const draft = prepared({ registrationId: randomUUID(), reused: false });
    const document = card("Release fixture");
    await store.create({
      intent: signed, requestHash: canonicalHash(signed), idempotencyKey: `release-test-${nonce}-${revision}`,
      serviceId, card: document, cardHash: canonicalHash(document), prepared: draft,
      providerOwner: address("a"), providerAgentWallet: address("b"), providerSigner: address("a"),
      supersedesRegistrationId: supersedes,
    });
    await store.recordEvidencePending({ registrationId: draft.registrationId, evidence: evidence(draft, nonce) });
    return { signed, draft };
  }
  it.each([true, false])("inherits visibility at activation, including a late operator change: %s", async (visible) => isolated(async (store) => {
    const prior = await successor(store, 0, "1");
    await store.activate(prior.draft.registrationId, []);
    const next = await successor(store, 0, "2", prior.draft.registrationId);
    await store.setVisibility(prior.draft.registrationId, visible, "catalog-operator");
    await store.activate(next.draft.registrationId, []);
    expect(await store.getActiveByServiceId(serviceId)).toMatchObject({ marketplaceEnabled: visible });
  }), 60_000);
  it("withdraws old pending work and refuses stale activation after a durable fence acknowledgment", async () => isolated(async (store) => {
    const pending = await successor(store, 1, "3");
    const higher = intent("4");
    (higher.payload as typeof higher.payload & { targetRevision: number }).targetRevision = 2;
    await expect(store.acknowledgeRevisionFence(higher)).resolves.toMatchObject({ targetRevision: 2, committed: true });
    expect(await store.get(pending.draft.registrationId)).toMatchObject({ state: "REJECTED" });
    await expect(store.activate(pending.draft.registrationId, [])).rejects.toThrow();
    await expect(successor(store, 0, "5")).rejects.toThrow("REGISTRATION_REVISION_FENCED");
    await expect(successor(store, 1, "6")).rejects.toThrow("REGISTRATION_REVISION_FENCED");
    const current = await successor(store, 2, "7");
    await expect(store.activate(current.draft.registrationId, [])).resolves.toMatchObject({ state: "ACTIVE" });
    await expect(store.acknowledgeRevisionFence(higher)).resolves.toMatchObject({ targetRevision: 2 });
    const refreshed = { ...higher, issuedAt: higher.issuedAt + 1, validBefore: higher.validBefore + 1 };
    await store.acknowledgeRevisionFence(refreshed);
    expect(await store.acknowledgedRevisionFence(canonicalHash(higher))).toMatchObject({ targetRevision: 2, committed: true });
    expect(await store.acknowledgedRevisionFence(canonicalHash(refreshed))).toMatchObject({ targetRevision: 2, committed: true });
    await expect(store.acknowledgeRevisionFence(pending.signed)).rejects.toThrow("REGISTRATION_REVISION_FENCED");
  }), 60_000);
});

// A provider pauses a service through card refresh alone: every skill's
// acceptingNewOrders false, the service-level flag (inside the service
// contract hash) left true. The public index and its detail view follow the
// listing rows the refresh writes.
describe("public service index availability", () => {
  interface SkillSpec { skillId: string; paid: boolean }
  const mixed: SkillSpec[] = [
    { skillId: "track-orbit", paid: true },
    { skillId: "move-orbit", paid: true },
    { skillId: "get-pricing", paid: false },
  ];

  async function isolated(work: (store: ServiceRegistrationStore, pool: Pool) => Promise<void>) {
    const schema = `public_index_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    try {
      await runMigrations(pool);
      await work(new ServiceRegistrationStore(pool), pool);
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }

  function serviceCard(id: Hex, skills: readonly SkillSpec[], accepting: readonly string[]): ProviderServiceCard {
    const base = card("Orbital Logistics");
    const template = base.skills[0]!;
    return {
      ...base,
      service: { ...base.service, serviceId: id, acceptingNewOrders: true },
      skills: skills.map((skill) => ({
        ...template,
        skillId: skill.skillId,
        acceptingNewOrders: accepting.includes(skill.skillId),
        contract: {
          ...template.contract,
          pricing: { USDC: { type: "one-time", fixed_amount: skill.paid ? "1000000" : "0" } },
          paymentRequired: skill.paid,
        },
      })),
    };
  }

  function servicePrepared(
    id: Hex,
    registrationId: string,
    skills: readonly SkillSpec[],
    prior: readonly PreparedListing[],
  ): PreparedServiceRegistration {
    const base = prepared({ registrationId, reused: false });
    return {
      ...base,
      serviceId: id,
      listings: skills.map((skill, index): PreparedListing => {
        const reused = prior.find((listing) => listing.skillId === skill.skillId);
        if (reused) return { ...reused, reused: true };
        const listingId = randomUUID();
        return {
          ...base.listings[0]!,
          listingId,
          listingKey: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
          skillId: skill.skillId,
          paymentRequired: skill.paid,
          splitterAddress: skill.paid ? address(String(index + 4)) : null,
          preparation: skill.paid
            ? envelope("GatewayListingPreparationV1", {
              registrationId, listingId, listingEpoch: "1",
            }) as unknown as PreparedListing["preparation"]
            : null,
        };
      }),
    };
  }

  async function register(
    store: ServiceRegistrationStore,
    id: Hex,
    skills: readonly SkillSpec[],
    nonce: string,
    supersedes: PreparedServiceRegistration | null = null,
  ): Promise<PreparedServiceRegistration> {
    const base = intent(nonce);
    const signed = { ...base, payload: { ...base.payload, serviceId: id } };
    const document = serviceCard(id, skills, skills.map((skill) => skill.skillId));
    const draft = servicePrepared(id, randomUUID(), skills, supersedes?.listings ?? []);
    await store.create({
      intent: signed, requestHash: canonicalHash(signed), idempotencyKey: `public-index-${nonce}`,
      serviceId: id, card: document, cardHash: canonicalHash(document), prepared: draft,
      providerOwner: address("a"), providerAgentWallet: address("b"), providerSigner: address("a"),
      supersedesRegistrationId: supersedes?.registrationId ?? null,
    });
    await store.recordEvidencePending({ registrationId: draft.registrationId, evidence: evidence(draft, nonce) });
    await store.activate(draft.registrationId, []);
    return draft;
  }

  // As the refresh loop writes it: each listing follows its skill's flag.
  async function publish(
    store: ServiceRegistrationStore,
    registration: PreparedServiceRegistration,
    skills: readonly SkillSpec[],
    accepting: readonly string[],
  ): Promise<void> {
    const document = serviceCard(registration.serviceId, skills, accepting);
    await store.refreshed({
      registrationId: registration.registrationId,
      card: document,
      cardHash: canonicalHash(document),
      chainActive: true,
      listingAvailability: registration.listings.map((listing) => ({
        listingId: listing.listingId,
        acceptingNewOrders: accepting.includes(listing.skillId),
      })),
    });
  }

  async function shown(store: ServiceRegistrationStore, id: Hex) {
    return {
      index: (await store.listPublic(100))
        .filter((record) => record.serviceId === id)
        .map((record) => record.registrationId),
      detail: (await store.getPublicByServiceId(id))?.registrationId ?? null,
    };
  }

  it("hides a service none of whose paid listings takes new orders and restores it on resume", async () => isolated(async (store) => {
    const registration = await register(store, serviceId, mixed, "1");
    const listed = { index: [registration.registrationId], detail: registration.registrationId };
    const hidden = { index: [], detail: null };
    expect(await shown(store, serviceId)).toEqual(listed);

    await publish(store, registration, mixed, []);
    expect(await shown(store, serviceId)).toEqual(hidden);
    // Paused through the skills alone: the registration stays active,
    // visible and healthy, with its service-level flag untouched.
    expect(await store.get(registration.registrationId)).toMatchObject({
      state: "ACTIVE", marketplaceEnabled: true, cardAcceptingOrders: true,
      chainActive: true, registrationHealthy: true,
    });

    // A paid service takes new orders only through its paid listings.
    await publish(store, registration, mixed, ["get-pricing"]);
    expect(await shown(store, serviceId)).toEqual(hidden);

    await publish(store, registration, mixed, ["move-orbit"]);
    expect(await shown(store, serviceId)).toEqual(listed);

    await publish(store, registration, mixed, []);
    expect(await shown(store, serviceId)).toEqual(hidden);
    await publish(store, registration, mixed, mixed.map((skill) => skill.skillId));
    expect(await shown(store, serviceId)).toEqual(listed);
  }), 60_000);

  it("follows the rows of reused listings, which stay under the first registration", async () => isolated(async (store) => {
    const first = await register(store, serviceId, mixed, "2");
    const second = await register(store, serviceId, mixed, "3", first);
    expect(second.listings.every((listing) => listing.reused)).toBe(true);
    expect(await shown(store, serviceId)).toEqual({
      index: [second.registrationId], detail: second.registrationId,
    });

    await publish(store, second, mixed, []);
    expect(await shown(store, serviceId)).toEqual({ index: [], detail: null });

    await publish(store, second, mixed, ["track-orbit"]);
    expect(await shown(store, serviceId)).toEqual({
      index: [second.registrationId], detail: second.registrationId,
    });
  }), 60_000);

  it("judges a service without a paid listing by its free listings", async () => isolated(async (store) => {
    const free: SkillSpec[] = [{ skillId: "get-pricing", paid: false }];
    const registration = await register(store, serviceId, free, "4");
    const listed = { index: [registration.registrationId], detail: registration.registrationId };
    expect(await shown(store, serviceId)).toEqual(listed);

    await publish(store, registration, free, []);
    expect(await shown(store, serviceId)).toEqual({ index: [], detail: null });

    await publish(store, registration, free, ["get-pricing"]);
    expect(await shown(store, serviceId)).toEqual(listed);
  }), 60_000);

  it("applies a refresh in one transaction, and only to an active registration", async () => isolated(async (store) => {
    const registration = await register(store, serviceId, mixed, "5");
    const open = mixed.map((skill) => skill.skillId);
    const paused = serviceCard(serviceId, mixed, []);
    await expect(store.refreshed({
      registrationId: registration.registrationId,
      card: paused,
      cardHash: canonicalHash(paused),
      chainActive: true,
      listingAvailability: [
        ...registration.listings.map((listing) => ({ listingId: listing.listingId, acceptingNewOrders: false })),
        { listingId: "not-a-listing-id", acceptingNewOrders: false },
      ],
    })).rejects.toThrow();
    // Nothing of the failed refresh landed: neither the card nor any flag.
    expect((await store.get(registration.registrationId))?.card)
      .toEqual(serviceCard(serviceId, mixed, open));
    expect((await store.listingCommitments(registration.listings.map((listing) => listing.listingId)))
      .map((row) => row.acceptingNewOrders)).toEqual([true, true, true]);
    expect(await shown(store, serviceId)).toEqual({
      index: [registration.registrationId], detail: registration.registrationId,
    });

    // A refresh that lands after its registration was superseded writes
    // nothing, so its card cannot pause the listings the successor reused.
    const successor = await register(store, serviceId, mixed, "6", registration);
    await publish(store, registration, mixed, []);
    expect(await shown(store, serviceId)).toEqual({
      index: [successor.registrationId], detail: successor.registrationId,
    });
  }), 60_000);

  // 3,000 services with two paid listings and one free one each; every odd
  // service is paused (only its free listing accepts). The listings must be
  // read through their primary key: a lookup that scans the listings table per
  // candidate registration took seconds at this size.
  it("reads listings through their primary key at scale", async () => isolated(async (_store, pool) => {
    await pool.query(`
      INSERT INTO standard_service_registrations
       (registration_id,provider_agent_id,service_id,service_slug,service_version,
        agent_card_url,service_wallet,provider_owner,provider_agent_wallet,provider_signer,
        idempotency_key,provider_payee,registration_nonce,request_hash,canonical_intent,
        prepared_json,card_json,card_hash,skill_contract_set_hash,state,marketplace_enabled,
        card_accepting_orders,chain_active,registration_healthy,last_refreshed_at,activated_at)
      SELECT registration_id,'42',decode(lpad(to_hex(g),64,'0'),'hex'),'service-'||g,'1',
        'https://provider.example/card.json','0x'||repeat('3',40),'0x'||repeat('a',40),
        '0x'||repeat('b',40),'0x'||repeat('a',40),'scale-key-'||g,'0x'||repeat('2',40),
        decode(lpad(to_hex(g),64,'0'),'hex'),decode(lpad(to_hex(g),64,'0'),'hex'),'{}'::jsonb,
        jsonb_build_object('listings',jsonb_build_array(
          jsonb_build_object('listingId',gen_random_uuid(),'paymentRequired',true),
          jsonb_build_object('listingId',gen_random_uuid(),'paymentRequired',true),
          jsonb_build_object('listingId',gen_random_uuid(),'paymentRequired',false))),
        '{}'::jsonb,decode(lpad(to_hex(g),64,'0'),'hex'),decode(lpad(to_hex(g),64,'0'),'hex'),
        'ACTIVE',true,true,true,true,now(),now() - g * interval '1 second'
      FROM (SELECT g, gen_random_uuid() AS registration_id FROM generate_series(1,3000) g) seeded;
      INSERT INTO standard_service_listings
       (listing_id,registration_id,listing_key,skill_id,skill_contract_hash,payment_required,
        accepting_new_orders,deployment_required,splitter_address,preparation_json,state)
      SELECT (item->>'listingId')::uuid,r.registration_id,decode(lpad(to_hex(position::int),64,'0'),'hex'),
        'skill-'||position,decode(repeat('5',64),'hex'),(item->>'paymentRequired')::boolean,
        NOT (item->>'paymentRequired')::boolean OR get_byte(r.service_id,31) % 2 = 0,false,
        CASE WHEN (item->>'paymentRequired')::boolean THEN '0x'||repeat('4',40) END,
        CASE WHEN (item->>'paymentRequired')::boolean THEN '{}'::jsonb END,'ACTIVE'
      FROM standard_service_registrations r,
           jsonb_array_elements(r.prepared_json->'listings') WITH ORDINALITY AS listed(item,position);
      ANALYZE standard_service_registrations;
      ANALYZE standard_service_listings;`);
    const sent: Array<{ text: string; values: unknown[] }> = [];
    const recording = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== "query") return Reflect.get(target, property, receiver);
        return (text: string, values: unknown[] = []) => {
          sent.push({ text, values });
          return target.query(text, values);
        };
      },
    });
    const observed = new ServiceRegistrationStore(recording);
    const open = (id: Hex) => parseInt(id.slice(-2), 16) % 2 === 0;
    const listed = await observed.listPublic(500);
    expect(listed).toHaveLength(500);
    expect(listed.every((record) => open(record.serviceId))).toBe(true);
    const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    expect(await observed.getPublicByServiceId(id(2))).not.toBeNull();
    expect(await observed.getPublicByServiceId(id(3))).toBeNull();
    expect(sent).toHaveLength(3);

    interface PlanNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; Plans?: PlanNode[] }
    const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
    for (const { text, values } of sent) {
      const explained = await pool.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
        `EXPLAIN (FORMAT JSON) ${text}`, values);
      const plan = nodes(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
      expect(plan.filter((node) =>
        node["Relation Name"] === "standard_service_listings" && node["Node Type"] === "Seq Scan"))
        .toEqual([]);
      expect(plan.some((node) => node["Index Name"] === "standard_service_listings_pkey")).toBe(true);
    }
  }), 60_000);
});
