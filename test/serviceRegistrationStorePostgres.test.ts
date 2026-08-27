import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { createPool, runMigrations } from "../src/db/pool.js";
import { ServiceRegistrationStore } from "../src/serviceRegistration/store.js";
import type {
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
        fulfillmentMode: "automated",
        acceptingNewOrders: true,
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
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
