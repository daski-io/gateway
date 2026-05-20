import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { computeServiceId } from "../src/payment/requirements.js";
import type { Hex } from "../src/types.js";

const PROVIDER_A2A = "http://provider.test/a2a";

async function seedPaid(
  gateway: TestGateway,
  args: {
    serviceRef: Hex;
    providerAgentId: bigint;
    buyerAgentId: bigint;
    amountAtomic: bigint;
    skillId?: string;
    paymentId: bigint;
    txHash: Hex;
    /**
     * On-chain serviceId baked into the challenge. Defaults to ZERO so
     * older tests that don't care continue to pass; tests that exercise
     * service-scoped queries pass the computed serviceId so the row is
     * findable via `listRecentPaidByServiceId`.
     */
    serviceId?: Hex;
    serviceSlug?: string;
    /**
     * Optional override for the chain_events row's settled_at. Tests that
     * exercise time-ordering across seeded rows pass distinct values to
     * pin the sort order; the default lets the DB stamp now(). The
     * payment_challenges side always uses now() via recordChallengePaid.
     */
    settledAt?: Date;
  },
): Promise<void> {
  const queries = gateway.bundle.queries;
  const serviceId = args.serviceId ?? (("0x" + "00".repeat(32)) as Hex);
  // Insert as pending, then flip to paid via the same atomic UPDATE the
  // facilitator uses in production. This exercises the real `recordChallengePaid`
  // semantics (single-use service_ref, verified_at populated by SQL).
  await queries.insertChallenge({
    serviceRef: args.serviceRef,
    providerTokenId: args.providerAgentId,
    buyerTokenId: args.buyerAgentId,
    amount: args.amountAtomic,
    skillId: args.skillId ?? null,
    serviceSlug: args.serviceSlug ?? args.skillId ?? "test-service",
    serviceVersion: "1",
    serviceId,
    providerA2AUrl: PROVIDER_A2A,
    walletAddress: gateway.buyerAddress,
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  const ok = await queries.recordChallengePaid(
    args.serviceRef,
    args.paymentId,
    args.txHash,
  );
  if (!ok) throw new Error("recordChallengePaid did not transition the row");

  // Mirror the production indexer: upsert a chain_events row so the
  // /activity and per-service surfaces (which now read from chain_events
  // LEFT JOIN payment_challenges) find the seeded transaction.
  await queries.upsertChainEvent({
    paymentId: args.paymentId,
    txHash: args.txHash,
    blockNumber: 1n,
    serviceId,
    buyerAgentId: args.buyerAgentId,
    providerAgentId: args.providerAgentId,
    amountAtomic: args.amountAtomic,
    settledAt: args.settledAt ?? new Date(),
    outcomeCode: null,
    confirmationCode: 0,
    fulfillmentSeconds: null,
    refundedAtomic: 0n,
  });
}

/**
 * Seed a chain-only row — present in chain_events but with no matching
 * payment_challenges entry. Used by tests that exercise the "settled
 * outside this gateway" path: the activity row should still render with
 * thinner metadata (skillId null, etc.).
 */
const OUTCOME_CODE: Record<string, number> = {
  Completed: 0,
  Failed: 1,
  Canceled: 2,
};
const CONFIRMATION_CODE: Record<string, number> = {
  Pending: 0,
  Confirmed: 1,
  NotConfirmed: 2,
};

/**
 * Partial chain_events update for tests that simulate later attestation
 * arrivals (outcome attest, buyer confirmation, refund). Production
 * uses the full-row `refreshChainEvent`; tests want field-by-field
 * patches so they don't have to repeat all four columns.
 */
async function patchChainEvent(
  gateway: TestGateway,
  paymentId: bigint,
  patch: {
    outcome?: "Completed" | "Failed" | "Canceled" | null;
    confirmation?: "Pending" | "Confirmed" | "NotConfirmed";
    fulfillmentSeconds?: number | null;
    refundedAtomic?: bigint;
  },
): Promise<void> {
  const sets: string[] = ["last_refreshed_at = now()"];
  const args: unknown[] = [];
  let i = 1;
  if ("outcome" in patch) {
    sets.push(`outcome = $${i++}`);
    args.push(patch.outcome ? OUTCOME_CODE[patch.outcome] : null);
  }
  if ("confirmation" in patch) {
    sets.push(`confirmation = $${i++}`);
    args.push(CONFIRMATION_CODE[patch.confirmation!]);
  }
  if ("fulfillmentSeconds" in patch) {
    sets.push(`fulfillment_seconds = $${i++}`);
    args.push(patch.fulfillmentSeconds);
  }
  if ("refundedAtomic" in patch) {
    sets.push(`refunded_atomic = $${i++}`);
    args.push(patch.refundedAtomic!.toString());
  }
  args.push(paymentId.toString());
  await gateway.bundle.pool.query(
    `UPDATE chain_events SET ${sets.join(", ")} WHERE payment_id = $${i}`,
    args,
  );
}

async function seedChainOnly(
  gateway: TestGateway,
  args: {
    paymentId: bigint;
    txHash: Hex;
    serviceId: Hex;
    buyerAgentId: bigint;
    providerAgentId: bigint;
    amountAtomic: bigint;
    settledAt?: Date;
    outcomeCode?: number | null;
    confirmationCode?: number;
    fulfillmentSeconds?: number | null;
    refundedAtomic?: bigint;
  },
): Promise<void> {
  await gateway.bundle.queries.upsertChainEvent({
    paymentId: args.paymentId,
    txHash: args.txHash,
    blockNumber: 1n,
    serviceId: args.serviceId,
    buyerAgentId: args.buyerAgentId,
    providerAgentId: args.providerAgentId,
    amountAtomic: args.amountAtomic,
    settledAt: args.settledAt ?? new Date(),
    outcomeCode: args.outcomeCode ?? null,
    confirmationCode: args.confirmationCode ?? 0,
    fulfillmentSeconds: args.fulfillmentSeconds ?? null,
    refundedAtomic: args.refundedAtomic ?? 0n,
  });
}

describe("public v1 — /services", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "12000000", // 12 USDC
          category: "domains",
          skills: [
            {
              id: "register-domain",
              name: "Register",
              description: "Register a new domain",
              metadata: {
                paymentRequired: true,
                baseAmount: "12000000",
                variablePricing: true,
              },
            },
          ],
        },
        {
          tokenId: 2n,
          name: "Other Provider",
          priceUsdcSmallest: "5000000",
          category: "compute",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns flattened services with USDC prices", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/services`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services).toHaveLength(2);
    expect(typeof body.cachedAt).toBe("string");

    const acme = body.services.find((s: any) => s.agentId === "1");
    expect(acme).toBeDefined();
    expect(acme.name).toBe("Acme Domains");
    expect(acme.category).toBe("domains");
    expect(acme.pricing.basePrice).toBe("12.00");
    expect(acme.pricing.currency).toBe("USDC");
    expect(acme.pricing.billingModel).toBe("one-time");
    expect(acme.skills).toHaveLength(1);
    expect(acme.skills[0]).toMatchObject({
      id: "register-domain",
      basePrice: "12.00",
      paymentRequired: true,
      variable: true,
    });
  });

  it("exposes per-skill requiredFields, asset/capability gating, and pricingModelDetail", async () => {
    // Re-seed with skills that exercise the full metadata surface.
    gateway.registerProvider({
      tokenId: 5n,
      name: "Rich Metadata Provider",
      priceUsdcSmallest: "0",
      category: "domains",
      skills: [
        {
          id: "register-domain",
          name: "Register",
          description: "Register a new domain",
          metadata: {
            paymentRequired: true,
            variablePricing: true,
            // Structured pricingModel: gateway should surface kind +
            // hint to integrators. Legacy `pricingModel: "live"` (flat
            // string) is also accepted; we test the structured shape.
            pricingModel: {
              kind: "live",
              source: "registrar",
              hint: "Quote at purchase via Name.com.",
            },
            requiredFields: [
              "domain",
              "registrantName",
              "registrantEmail",
            ],
          },
        },
        {
          id: "set-dns-record",
          name: "Set DNS",
          description: "Update a DNS record",
          metadata: {
            paymentRequired: false,
            requiresAssetOwnership: true,
            requiresCapability: true,
            assetType: "domain",
            requiredFields: ["domain", "recordType", "name", "content"],
          },
        },
      ],
    });
    await gateway.refresh();

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const skills = body.skills as Array<Record<string, unknown>>;

    const reg = skills.find((s) => s.id === "register-domain");
    expect(reg).toBeDefined();
    expect(reg!.requiredFields).toEqual([
      "domain",
      "registrantName",
      "registrantEmail",
    ]);
    expect(reg!.requiresAssetOwnership).toBe(false);
    expect(reg!.requiresCapability).toBe(false);
    expect(reg!.pricingModel).toBe("live");
    expect(reg!.pricingModelDetail).toEqual({
      kind: "live",
      source: "registrar",
      hint: "Quote at purchase via Name.com.",
    });

    const dns = skills.find((s) => s.id === "set-dns-record");
    expect(dns).toBeDefined();
    expect(dns!.requiresAssetOwnership).toBe(true);
    expect(dns!.requiresCapability).toBe(true);
    expect(dns!.assetType).toBe("domain");
    expect(dns!.paymentRequired).toBe(false);
  });

  it("sources providerAddress from IdentityRegistry.getAgentWallet (picks up wallet rotation)", async () => {
    // ProviderRegistry.walletAddress is documented as a deprecated hint;
    // PaymentRouter resolves payees through IdentityRegistry. If the
    // gateway trusted the deprecated field, a rotated provider would have
    // its old wallet displayed on the marketing site while settlements
    // correctly went to the new one. Verify the cache picks up the live
    // wallet from IdentityRegistry.
    const ROTATED = "0x000000000000000000000000000000000000beef" as Hex;
    gateway.mockChain.setAgentWallet(1n, ROTATED);
    await gateway.refresh();

    const res = await fetch(`${gateway.baseUrl}/public/v1/services`);
    const body = (await res.json()) as any;
    const acme = body.services.find((s: any) => s.agentId === "1");
    expect(acme.providerAddress.toLowerCase()).toBe(ROTATED);
  });

  it("excludes providers without the marketplace extension", async () => {
    gateway.registerProvider({
      tokenId: 99n,
      name: "Plain A2A Provider",
      priceUsdcSmallest: "1000000",
      category: "ignored",
      skipExtension: true,
    });
    await gateway.refresh();

    const res = await fetch(`${gateway.baseUrl}/public/v1/services`);
    const body = (await res.json()) as any;
    expect(body.services.find((s: any) => s.agentId === "99")).toBeUndefined();
  });
});

describe("public v1 — /services/:agentId", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "12000000",
          category: "domains",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns the service plus an empty recentPurchases when no paid rows exist", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agentId).toBe("1");
    expect(body.name).toBe("Acme Domains");
    expect(body.recentPurchases).toEqual([]);
  });

  it("includes recent purchases for that provider only", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 100n,
      txHash:
        "0xabc1111111111111111111111111111111111111111111111111111111111111",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    const body = (await res.json()) as any;
    expect(body.recentPurchases).toHaveLength(1);
    expect(body.recentPurchases[0]).toMatchObject({
      txHash:
        "0xabc1111111111111111111111111111111111111111111111111111111111111",
      buyerAgentId: "7",
      providerAgentId: "1",
      providerName: "Acme Domains",
      amount: "12.00",
      skillId: "register-domain",
    });
    expect(typeof body.recentPurchases[0].timestamp).toBe("string");
    // Default shape when ReputationStorage isn't configured / no record yet:
    // outcome unknown, confirmation pending, no fulfillment time. Matches
    // the contract's zero-init struct semantics.
    expect(body.recentPurchases[0].outcome).toBeNull();
    expect(body.recentPurchases[0].confirmation).toBe("Pending");
    expect(body.recentPurchases[0].fulfillmentSeconds).toBeNull();
    // PaymentRouter is always configured — refundedUsdc has the "0.00"
    // default rather than null. Confirmation UID is null until the buyer
    // attests via /confirm/:paymentId.
    expect(body.recentPurchases[0].refundedUsdc).toBe("0.00");
    expect(body.recentPurchases[0].confirmationAttestationUid).toBeNull();
  });

  it("resolves buyerName from the buyer's IdentityRegistry tokenURI metadata, or null on failure", async () => {
    // Two paid rows: one buyer (7n) has a data: URI with a resolvable
    // name, the other (8n) has no agentURI registered on the mock so the
    // resolver call throws — the cache must catch and surface null
    // rather than break the response.
    const buyerCard = { name: "  Alice the Buyer  " }; // trimmed by fetchAgentCard
    gateway.mockChain.setAgentURI(
      7n,
      `data:application/json,${encodeURIComponent(JSON.stringify(buyerCard))}`,
    );

    await seedPaid(gateway, {
      serviceRef:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 110n,
      txHash:
        "0xabc1010101010101010101010101010101010101010101010101010101010101",
    });
    await seedPaid(gateway, {
      serviceRef:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      providerAgentId: 1n,
      buyerAgentId: 8n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 111n,
      txHash:
        "0xabc2020202020202020202020202020202020202020202020202020202020202",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    const body = (await res.json()) as any;

    const rowResolved = body.recentPurchases.find(
      (r: any) => r.buyerAgentId === "7",
    );
    expect(rowResolved.buyerName).toBe("Alice the Buyer");

    const rowUnresolvable = body.recentPurchases.find(
      (r: any) => r.buyerAgentId === "8",
    );
    // Resolver couldn't read tokenURI → null. The row still renders.
    expect(rowUnresolvable.buyerName).toBeNull();
  });

  it("surfaces on-chain outcome, confirmation, and fulfillmentSeconds from ReputationStorage.getRecord", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 101n,
      txHash:
        "0xabc4444444444444444444444444444444444444444444444444444444444444",
    });

    // Mirror the post-outcome-attest shape: contract has computed
    // fulfillmentTime as block.timestamp - paidAt; buyer has subsequently
    // attested Confirmed. The chain-events indexer would write these
    // values on its next refresh sweep — the test patches them directly.
    await patchChainEvent(gateway, 101n, {
      outcome: "Completed",
      confirmation: "Confirmed",
      fulfillmentSeconds: 1234,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    const body = (await res.json()) as any;
    const row = body.recentPurchases.find(
      (r: any) =>
        r.txHash ===
        "0xabc4444444444444444444444444444444444444444444444444444444444444",
    );
    expect(row).toBeDefined();
    expect(row.outcome).toBe("Completed");
    expect(row.confirmation).toBe("Confirmed");
    expect(row.fulfillmentSeconds).toBe(1234);
  });

  it("computes averageFulfillmentSeconds + fulfillmentSampleSize over the recent paid sample", async () => {
    // Provider with explicit serviceSlug metadata, so derivePrimaryServiceId
    // returns the same on-chain serviceId we'll bake into the seeded rows
    // — that's what `listRecentPaidByServiceId` filters on.
    gateway.registerProvider({
      tokenId: 9n,
      name: "Fulfillment Stats Provider",
      priceUsdcSmallest: "1000000",
      category: "domains",
      skills: [
        {
          id: "register-domain",
          metadata: {
            paymentRequired: true,
            baseAmount: "1000000",
            serviceSlug: "domain-registration",
          },
        },
      ],
    });
    await gateway.refresh();

    const serviceId = computeServiceId(9n, "domain-registration", "1");

    // ReputationStorage must be "configured" for the public route to
    // attempt service-scoped reads. Set a zeroed counter — the aggregate
    // is what we're testing, not the counter values themselves.
    gateway.mockChain.setServiceReputation(serviceId, {
      completed: 3n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
      totalRefunded: 0n,
    });

    // Three completed records: 10s, 20s, 60s → mean = 30s exact.
    const fulfillments = [
      { paymentId: 901n, seconds: 10n },
      { paymentId: 902n, seconds: 20n },
      { paymentId: 903n, seconds: 60n },
    ];
    for (const [i, { paymentId, seconds }] of fulfillments.entries()) {
      await seedPaid(gateway, {
        serviceRef: ("0x" + (i + 90).toString(16).padStart(64, "0")) as Hex,
        providerAgentId: 9n,
        buyerAgentId: 11n,
        amountAtomic: 1_000_000n,
        skillId: "register-domain",
        paymentId,
        txHash: ("0x" + (i + 200).toString(16).padStart(64, "0")) as Hex,
        serviceId,
        serviceSlug: "domain-registration",
      });
      await patchChainEvent(gateway, paymentId, {
        outcome: "Completed",
        fulfillmentSeconds: Number(seconds),
      });
    }

    // Plus one row whose outcome hasn't been attested — should NOT
    // contribute to the mean. Mirrors a real "settled but waiting on
    // provider" state.
    await seedPaid(gateway, {
      serviceRef: ("0x" + "f0".repeat(32)) as Hex,
      providerAgentId: 9n,
      buyerAgentId: 11n,
      amountAtomic: 1_000_000n,
      skillId: "register-domain",
      paymentId: 904n,
      txHash: ("0x" + "f1".repeat(32)) as Hex,
      serviceId,
      serviceSlug: "domain-registration",
    });
    // No setReputationRecord call → record returns null → excluded.

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/9`);
    const body = (await res.json()) as any;
    expect(body.serviceReputation).not.toBeNull();
    expect(body.serviceReputation.averageFulfillmentSeconds).toBe(30);
    expect(body.serviceReputation.fulfillmentSampleSize).toBe(3);
  });

  it("surfaces totalSpentUsdc on both reputation (provider) and serviceReputation (service)", async () => {
    gateway.registerProvider({
      tokenId: 11n,
      name: "Spend Stats Provider",
      priceUsdcSmallest: "1000000",
      category: "domains",
      skills: [
        {
          id: "register-domain",
          metadata: {
            paymentRequired: true,
            baseAmount: "1000000",
            serviceSlug: "domain-registration",
          },
        },
      ],
    });
    await gateway.refresh();

    const serviceId = computeServiceId(11n, "domain-registration", "1");
    // ReputationStorage needs to be "configured" for the public route to
    // return a populated reputation block. Counters can be zero — spend
    // is what we're testing, sourced from the gateway DB not the contract.
    gateway.mockChain.setProviderReputation(11n, {
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
    });
    gateway.mockChain.setServiceReputation(serviceId, {
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
      totalRefunded: 0n,
    });

    // Two paid rows on this service: 12.34 + 7.66 = 20.00 USDC.
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a1".repeat(32)) as Hex,
      providerAgentId: 11n,
      buyerAgentId: 5n,
      amountAtomic: 12_340_000n,
      skillId: "register-domain",
      paymentId: 1101n,
      txHash: ("0x" + "b1".repeat(32)) as Hex,
      serviceId,
      serviceSlug: "domain-registration",
    });
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a2".repeat(32)) as Hex,
      providerAgentId: 11n,
      buyerAgentId: 5n,
      amountAtomic: 7_660_000n,
      skillId: "register-domain",
      paymentId: 1102n,
      txHash: ("0x" + "b2".repeat(32)) as Hex,
      serviceId,
      serviceSlug: "domain-registration",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/11`);
    const body = (await res.json()) as any;
    expect(body.reputation.totalSpentUsdc).toBe("20.00");
    expect(body.serviceReputation.totalSpentUsdc).toBe("20.00");
  });

  it("reports null averageFulfillmentSeconds when no paid rows have outcome records", async () => {
    gateway.registerProvider({
      tokenId: 10n,
      name: "No Fulfillment Yet",
      priceUsdcSmallest: "1000000",
      category: "domains",
      skills: [
        {
          id: "register-domain",
          metadata: {
            paymentRequired: true,
            baseAmount: "1000000",
            serviceSlug: "domain-registration",
          },
        },
      ],
    });
    await gateway.refresh();
    const serviceId = computeServiceId(10n, "domain-registration", "1");
    gateway.mockChain.setServiceReputation(serviceId, {
      completed: 0n,
      failed: 0n,
      canceled: 0n,
      confirmed: 0n,
      notConfirmed: 0n,
      totalRefunded: 0n,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/10`);
    const body = (await res.json()) as any;
    expect(body.serviceReputation.averageFulfillmentSeconds).toBeNull();
    expect(body.serviceReputation.fulfillmentSampleSize).toBe(0);
  });

  it("returns 404 for an unknown agentId", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/services/999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("SERVICE_NOT_FOUND");
  });

  it("returns 404 for a non-numeric agentId", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/services/abc`);
    expect(res.status).toBe(404);
  });
});

describe("public v1 — /activity", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "12000000",
          category: "domains",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns paid rows joined with provider names", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      providerAgentId: 1n,
      buyerAgentId: 5n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 200n,
      txHash:
        "0xdef2222222222222222222222222222222222222222222222222222222222222",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]).toMatchObject({
      providerAgentId: "1",
      providerName: "Acme Domains",
      buyerAgentId: "5",
      amount: "12.00",
      skillId: "register-domain",
    });
    expect(body.activity[0].outcome).toBeNull();
    expect(body.activity[0].confirmation).toBe("Pending");
    expect(body.activity[0].fulfillmentSeconds).toBeNull();
    expect(body.activity[0].refundedUsdc).toBe("0.00");
    expect(body.activity[0].confirmationAttestationUid).toBeNull();
  });

  it("resolves buyerName from the buyer's IdentityRegistry tokenURI metadata on activity rows", async () => {
    // Same resolution contract as recentPurchases — one buyer has a
    // readable name, the other has no agentURI and degrades to null.
    gateway.mockChain.setAgentURI(
      5n,
      `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Bob the Buyer" }))}`,
    );

    await seedPaid(gateway, {
      serviceRef:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      providerAgentId: 1n,
      buyerAgentId: 5n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 210n,
      txHash:
        "0xdef1010101010101010101010101010101010101010101010101010101010101",
    });
    await seedPaid(gateway, {
      serviceRef:
        "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      providerAgentId: 1n,
      buyerAgentId: 99n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 211n,
      txHash:
        "0xdef2020202020202020202020202020202020202020202020202020202020202",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const body = (await res.json()) as any;
    const known = body.activity.find((r: any) => r.buyerAgentId === "5");
    expect(known.buyerName).toBe("Bob the Buyer");
    const unknown = body.activity.find((r: any) => r.buyerAgentId === "99");
    expect(unknown.buyerName).toBeNull();
  });

  it("surfaces PaymentRouter.refundedAmount per activity row", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      providerAgentId: 1n,
      buyerAgentId: 5n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 202n,
      txHash:
        "0xdef6666666666666666666666666666666666666666666666666666666666666",
    });
    // Half refund — exercises the formatter's USDC conversion (no special
    // case for partial-vs-full) and shows the buyer the partial state.
    // chain_events refund column is the source post-refactor; the mock
    // chain reader's refund value is only used by the indexer.
    await patchChainEvent(gateway, 202n, { refundedAtomic: 6_000_000n });

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const body = (await res.json()) as any;
    const row = body.activity.find(
      (r: any) =>
        r.txHash ===
        "0xdef6666666666666666666666666666666666666666666666666666666666666",
    );
    expect(row.refundedUsdc).toBe("6.00");
  });

  it("persists EAS UID on /confirm and surfaces it on the matching activity row", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x7777777777777777777777777777777777777777777777777777777777777777",
      providerAgentId: 1n,
      buyerAgentId: 5n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 203n,
      txHash:
        "0xdef7777777777777777777777777777777777777777777777777777777777777",
    });

    const attestationUid =
      "0xcafe000000000000000000000000000000000000000000000000000000000abc" as Hex;
    const txHash =
      "0xdead000000000000000000000000000000000000000000000000000000000abc" as Hex;
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash,
      attestationUid,
    });

    const confirmRes = await fetch(`${gateway.baseUrl}/confirm/203`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "Confirmed",
        attester: "0x000000000000000000000000000000000000beef",
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        signature: {
          v: 27,
          r: "0x1111111111111111111111111111111111111111111111111111111111111111",
          s: "0x2222222222222222222222222222222222222222222222222222222222222222",
        },
      }),
    });
    expect(confirmRes.status).toBe(200);

    const activityRes = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const body = (await activityRes.json()) as any;
    const row = body.activity.find(
      (r: any) =>
        r.txHash ===
        "0xdef7777777777777777777777777777777777777777777777777777777777777",
    );
    expect(row.confirmationAttestationUid).toBe(attestationUid);
  });

  it("emits fulfillmentSeconds + outcome on activity rows once provider attests", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x5555555555555555555555555555555555555555555555555555555555555555",
      providerAgentId: 1n,
      buyerAgentId: 5n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 201n,
      txHash:
        "0xdef5555555555555555555555555555555555555555555555555555555555555",
    });
    // Provider has attested Completed; buyer hasn't confirmed yet.
    await patchChainEvent(gateway, 201n, {
      outcome: "Completed",
      fulfillmentSeconds: 42,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const body = (await res.json()) as any;
    const row = body.activity.find(
      (r: any) =>
        r.txHash ===
        "0xdef5555555555555555555555555555555555555555555555555555555555555",
    );
    expect(row.outcome).toBe("Completed");
    expect(row.confirmation).toBe("Pending");
    expect(row.fulfillmentSeconds).toBe(42);
  });

  it("respects ?limit and caps to 200", async () => {
    for (let i = 0; i < 3; i++) {
      await seedPaid(gateway, {
        serviceRef: ("0x" + (i + 10).toString(16).padStart(64, "0")) as Hex,
        providerAgentId: 1n,
        buyerAgentId: BigInt(100 + i),
        amountAtomic: 1_000_000n,
        paymentId: BigInt(300 + i),
        txHash: ("0x" + (i + 20).toString(16).padStart(64, "0")) as Hex,
      });
    }

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity?limit=2`);
    const body = (await res.json()) as any;
    expect(body.activity).toHaveLength(2);
  });

  it("falls back to the default limit on invalid input", async () => {
    const res = await fetch(
      `${gateway.baseUrl}/public/v1/activity?limit=notanumber`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.activity)).toBe(true);
  });
});

describe("public v1 — /stats", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "12000000",
          category: "domains",
        },
      ],
    });
    gateway.mockChain.setBlockNumber(12_847_392n);
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns chain, marketplace, and contract addresses", async () => {
    await seedPaid(gateway, {
      serviceRef:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      providerAgentId: 1n,
      buyerAgentId: 9n,
      amountAtomic: 12_000_000n,
      paymentId: 400n,
      txHash:
        "0x9994444444444444444444444444444444444444444444444444444444444444",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.chain).toMatchObject({
      chainId: 84532,
      network: "base-sepolia",
      blockNumber: "12847392",
    });
    expect(body.marketplace).toEqual({
      providerCount: 1,
      paidCount: 1,
      totalVolumeUsdc: "12.00",
    });
    expect(body.contracts.paymentRouter).toMatch(/^0x/);
    expect(body.contracts.usdc).toMatch(/^0x/);
    // Optional adapters not configured in tests — should serialise as null.
    expect(body.contracts.permitAdapter).toBeNull();
    expect(body.contracts.approvalAdapter).toBeNull();
  });

  it("returns zeroed marketplace stats when no paid rows exist", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/stats`);
    const body = (await res.json()) as any;
    expect(body.marketplace).toEqual({
      providerCount: 1,
      paidCount: 0,
      totalVolumeUsdc: "0.00",
    });
  });
});
