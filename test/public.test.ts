import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import {
  computeServiceId,
  derivePrimaryServiceId,
} from "../src/discovery/serviceIdentity.js";
import type { Hex } from "../src/types.js";
import {
  signedConfirmation,
  TEST_BUYER,
} from "./helpers/confirmation.js";

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
     * On-chain serviceId baked into the challenge. Defaults to the cached
     * provider's primary service; tests for another service pass an explicit
     * serviceId so the row is scoped to that card.
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
    reputationEligible?: boolean | null;
  },
): Promise<void> {
  const queries = gateway.bundle.queries;
  const provider = gateway.bundle.cache.get(args.providerAgentId);
  const primary = provider ? derivePrimaryServiceId(provider) : null;
  const serviceId =
    args.serviceId ?? primary?.serviceId ?? (("0x" + "00".repeat(32)) as Hex);
  // Insert as pending, then flip to paid via the same atomic UPDATE the
  // facilitator uses in production. This exercises the real `recordChallengePaid`
  // semantics (single-use service_ref, verified_at populated by SQL).
  await queries.insertChallenge({
    serviceRef: args.serviceRef,
    providerTokenId: args.providerAgentId,
    buyerTokenId: args.buyerAgentId,
    amount: args.amountAtomic,
    skillId: args.skillId ?? null,
    serviceSlug:
      args.serviceSlug ??
      primary?.serviceSlug ??
      args.skillId ??
      "test-service",
    serviceVersion: "1",
    serviceId,
    providerA2AUrl: PROVIDER_A2A,
    walletAddress: gateway.buyerAddress,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    serviceArgs: {},
    providerAuthority: {
      walletAddress:
        provider?.walletAddress ??
        ("0x0000000000000000000000000000000000000000" as Hex),
      agentURI: provider?.agentURI ?? "https://provider.test/agent.json",
      observedBlock: provider?.authorityObservedBlock ?? 0n,
    },
  });
  const ok = await queries.recordChallengePaid(
    args.serviceRef,
    args.paymentId,
    args.txHash,
  );
  if (!ok) throw new Error("recordChallengePaid did not transition the row");

  // Insert an authoritative projection fixture. Production writes this row
  // only through ChainEventsIndexer; this helper deliberately bypasses the
  // cursor so public-route tests can seed independent histories.
  await gateway.bundle.pool.query(
    `INSERT INTO chain_events
       (payment_id, tx_hash, block_number, service_id, buyer_agent_id,
        provider_agent_id, amount_atomic, settled_at, reputation_eligible)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)`,
    [
      args.paymentId.toString(),
      Buffer.from(args.txHash.slice(2), "hex"),
      Buffer.from(serviceId.slice(2), "hex"),
      args.buyerAgentId.toString(),
      args.providerAgentId.toString(),
      args.amountAtomic.toString(),
      args.settledAt ?? new Date(),
      args.reputationEligible === undefined ? true : args.reputationEligible,
    ],
  );
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
  const sets: string[] = [];
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

describe("public v1 — /services", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "12000000", // 12 USDC
          categoryFamily: "domains-web",
          serviceType: "domain-management",
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
          categoryFamily: "compute-ai",
          serviceType: "compute-ai-other",
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
    expect(acme.categoryFamily).toBe("domains-web");
    expect(acme.serviceType).toBe("domain-management");
    expect(acme.jurisdictions).toEqual(["global"]);
    expect(acme.pricing.basePrice).toBe("12.00");
    expect(acme.pricing.currency).toBe("USDC");
    expect(acme.pricing.billingModel).toBe("one-time");
    expect(acme.legal).toEqual({
      marketplaceTermsUrl: gateway.config.marketplaceTermsUrl,
      marketplacePrivacyUrl: gateway.config.marketplacePrivacyUrl,
      providerLegalName: "Example Provider, LLC",
      providerTermsUrl: "https://provider.example/terms",
      providerPrivacyUrl: "https://provider.example/privacy",
    });
    expect(acme.skills).toHaveLength(1);
    expect(acme.skills[0]).toMatchObject({
      id: "register-domain",
      basePrice: "12.00",
      paymentRequired: true,
      fulfillmentMode: "automated",
      variable: true,
    });
  });

  it("exposes per-skill requiredFields, asset/capability gating, and pricingModelDetail", async () => {
    // Re-seed with skills that exercise the full metadata surface.
    gateway.registerProvider({
      tokenId: 5n,
      name: "Rich Metadata Provider",
      priceUsdcSmallest: "0",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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
            requiredFields: ["domain", "registrantName", "registrantEmail"],
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
    expect(reg).not.toHaveProperty("pricingModel");
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
      categoryFamily: "other",
      serviceType: "other",
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
          categoryFamily: "domains-web",
          serviceType: "domain-management",
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

  it("falls back to buyer-<wallet-suffix> when the buyer has no agentURI but has a registered wallet", async () => {
    // Mirrors the e2e/SDK case: the agent exists on IdentityRegistry
    // (has a wallet) but registered without an agentURI (e.g. through a
    // third-party flow that didn't follow the gateway's MCP defaults).
    // Without a fallback the activity feed shows `null` for the buyer
    // name; with the fallback, it derives `buyer-<last6>` from the
    // wallet — same convention the gateway uses at registration time.
    const wallet = "0xABd98f58eCA6e676E613C4001dd4c497fBAA39aA" as Hex;
    gateway.mockChain.setAgentWallet(20n, wallet);
    // Explicitly no setAgentURI(20n, ...) — agentURI returns "".

    await seedPaid(gateway, {
      serviceRef:
        "0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".slice(
          0,
          66,
        ) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 20n,
      amountAtomic: 12_000_000n,
      skillId: "register-domain",
      paymentId: 220n,
      txHash:
        "0xabc2222020202020202020202020202020202020202020202020202020202020",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    const body = (await res.json()) as any;
    const row = body.recentPurchases.find((r: any) => r.buyerAgentId === "20");
    expect(row).toBeDefined();
    // Last 6 hex chars of `0xabd98f58eca6e676e613c4001dd4c497fbaa39aa` → "aa39aa".
    expect(row.buyerName).toBe("buyer-aa39aa");
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
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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
      categoryFamily: "domains-web",
      serviceType: "domain-management",
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
          categoryFamily: "domains-web",
          serviceType: "domain-management",
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

  it("resolves the purchased service (name/slug/id) per activity row", async () => {
    // Provider with an explicit serviceSlug in skill metadata, so
    // derivePrimaryServiceId yields the same serviceId we bake into the
    // seeded row — mirrors how a real purchase records its service. This is
    // the fix for the activity feed collapsing every row to the provider's
    // primary service name regardless of what was actually bought.
    gateway.registerProvider({
      tokenId: 9n,
      name: "Blue T Services",
      priceUsdcSmallest: "5000000",
      categoryFamily: "communications",
      serviceType: "agent-mailbox",
      skills: [
        {
          id: "create-mailbox",
          metadata: {
            paymentRequired: true,
            baseAmount: "5000000",
            serviceSlug: "mailboxes",
          },
        },
      ],
    });
    await gateway.refresh();

    const serviceId = computeServiceId(9n, "mailboxes", "1");
    const txHash = ("0x" + "a2".repeat(32)) as Hex;
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a1".repeat(32)) as Hex,
      providerAgentId: 9n,
      buyerAgentId: 7n,
      amountAtomic: 5_000_000n,
      skillId: "create-mailbox",
      paymentId: 250n,
      txHash,
      serviceId,
      serviceSlug: "mailboxes",
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const body = (await res.json()) as any;
    const row = body.activity.find((r: any) => r.txHash === txHash);
    expect(row).toBeDefined();
    expect(row.serviceName).toBe("Blue T Services");
    expect(row.serviceSlug).toBe("mailboxes");
    expect(String(row.serviceId).toLowerCase()).toBe(serviceId.toLowerCase());
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

  it("surfaces cumulative refund events per activity row", async () => {
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
    const provider = gateway.bundle.cache.get(1n);
    const serviceId = provider
      ? derivePrimaryServiceId(provider)?.serviceId
      : null;
    if (!serviceId) throw new Error("test provider has no primary service");
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash,
      attestationUid,
    });
    // /confirm reads the router record for the resolver-required recipient.
    gateway.mockChain.setPaymentRecord(203n, {
      buyerAgentId: 7n,
      providerAgentId: 1n,
      serviceId,
      token: "0x000000000000000000000000000000000000a003" as Hex,
      amount: 1_000_000n,
      cachedBuyerWallet: TEST_BUYER,
      cachedProviderOwner: "0x000000000000000000000000000000000000c001" as Hex,
      cachedProviderWallet: "0x000000000000000000000000000000000000c002" as Hex,
      serviceRef: ("0x" + "ab".repeat(32)) as Hex,
      paidAt: BigInt(Math.floor(Date.now() / 1000)),
      reputationEligible: true,
    });

    const confirmRes = await fetch(`${gateway.baseUrl}/confirm/203`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedConfirmation(gateway.config, {
          paymentId: 203n,
          confirmation: "Confirmed",
          recipient:
            "0x000000000000000000000000000000000000c002" as Hex,
        }),
      ),
    });
    expect(confirmRes.status).toBe(200);

    gateway.mockChain.pushChainProjectionEvent({
      kind: "confirmation_submitted",
      paymentId: 203n,
      providerAgentId: 1n,
      buyerAgentId: 5n,
      serviceId,
      confirmationCode: 1,
      attestationUid,
      blockNumber: 1n,
      transactionIndex: 0,
      logIndex: 0,
    });
    gateway.mockChain.setBlockNumber(20n);
    await gateway.bundle.indexer.tick();

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
          categoryFamily: "domains-web",
          serviceType: "domain-management",
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
      serviceCount: 1,
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
      serviceCount: 1,
      paidCount: 0,
      totalVolumeUsdc: "0.00",
    });
  });

  it("excludes false and unclassified payments from all public trust totals", async () => {
    for (const [paymentId, buyerAgentId, amountAtomic, eligible] of [
      [410n, 7n, 10_000_000n, true],
      [411n, 8n, 100_000_000n, false],
      [412n, 9n, 1_000_000_000n, null],
    ] as const) {
      await seedPaid(gateway, {
        serviceRef: `0x${paymentId.toString(16).padStart(64, "0")}` as Hex,
        providerAgentId: 1n,
        buyerAgentId,
        amountAtomic,
        paymentId,
        txHash:
          `0x${(paymentId + 1000n).toString(16).padStart(64, "0")}` as Hex,
        reputationEligible: eligible,
      });
    }

    const stats = (await (
      await fetch(`${gateway.baseUrl}/public/v1/stats`)
    ).json()) as any;
    expect(stats.marketplace.paidCount).toBe(1);
    expect(stats.marketplace.totalVolumeUsdc).toBe("10.00");

    const activity = (await (
      await fetch(`${gateway.baseUrl}/public/v1/activity`)
    ).json()) as any;
    expect(activity.activity).toHaveLength(1);
    expect(activity.activity[0].txHash).toBe(
      `0x${(410n + 1000n).toString(16).padStart(64, "0")}`,
    );

    const buyers = (await (
      await fetch(`${gateway.baseUrl}/public/v1/buyers`)
    ).json()) as any;
    expect(buyers.buyers.map((buyer: any) => buyer.agentId)).toEqual(["7"]);
  });
});

describe("public v1 — /buyers/:agentId", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "10000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          skills: [
            {
              id: "register-domain",
              metadata: {
                paymentRequired: true,
                baseAmount: "10000000",
              },
            },
          ],
        },
        {
          tokenId: 2n,
          name: "Other Provider",
          priceUsdcSmallest: "5000000",
          categoryFamily: "compute-ai",
          serviceType: "compute-ai-other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns 404 for a buyer with neither an on-chain identity nor activity", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers/999`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BUYER_NOT_FOUND");
  });

  it("returns 404 for unparseable agentIds", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers/not-a-number`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BUYER_NOT_FOUND");
  });

  it("aggregates spend, transactions, outcome and confirmation counters from chain_events", async () => {
    // Three settlements for buyer 7: two with Acme, one with Other Provider.
    // After patching: 2 Completed (one Confirmed, one NotConfirmed) + 1 Failed
    // (still Pending). Skill mix: register-domain twice + default-service once.
    await seedPaid(gateway, {
      serviceRef: ("0x" + "aa".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 10_000_000n,
      skillId: "register-domain",
      paymentId: 501n,
      txHash: ("0x" + "01".repeat(32)) as Hex,
    });
    await patchChainEvent(gateway, 501n, {
      outcome: "Completed",
      confirmation: "Confirmed",
      fulfillmentSeconds: 60,
    });

    await seedPaid(gateway, {
      serviceRef: ("0x" + "bb".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 20_000_000n,
      skillId: "register-domain",
      paymentId: 502n,
      txHash: ("0x" + "02".repeat(32)) as Hex,
    });
    await patchChainEvent(gateway, 502n, {
      outcome: "Completed",
      confirmation: "NotConfirmed",
      fulfillmentSeconds: 120,
      refundedAtomic: 5_000_000n,
    });

    await seedPaid(gateway, {
      serviceRef: ("0x" + "cc".repeat(32)) as Hex,
      providerAgentId: 2n,
      buyerAgentId: 7n,
      amountAtomic: 5_000_000n,
      skillId: "default-service",
      paymentId: 503n,
      txHash: ("0x" + "03".repeat(32)) as Hex,
    });
    await patchChainEvent(gateway, 503n, { outcome: "Failed" });

    // Unrelated row for a different buyer — must not bleed into 7's counters.
    await seedPaid(gateway, {
      serviceRef: ("0x" + "dd".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 8n,
      amountAtomic: 10_000_000n,
      skillId: "register-domain",
      paymentId: 504n,
      txHash: ("0x" + "04".repeat(32)) as Hex,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers/7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.reputation.transactions).toBe(3);
    expect(body.reputation.totalSpentUsdc).toBe("35.00"); // 10 + 20 + 5
    expect(body.reputation.averageTransactionUsdc).toBe("11.67"); // (10+20+5)/3 atomic = 11_666_666 → toFixed(2) → 11.67
    expect(body.reputation.totalRefundedUsdc).toBe("5.00");
    expect(body.reputation.refundReceivedRate).toBeCloseTo(1 / 3);

    // Outcomes (provider-attested via patch)
    expect(body.reputation.completedCount).toBe(2);
    expect(body.reputation.failedCount).toBe(1);
    expect(body.reputation.canceledCount).toBe(0);
    expect(body.reputation.completionRate).toBeCloseTo(2 / 3);

    // Confirmations (buyer-attested). One Confirmed, one NotConfirmed, one
    // Pending → attestation_rate = 1/2, coverage = 2/3.
    expect(body.reputation.confirmedCount).toBe(1);
    expect(body.reputation.notConfirmedCount).toBe(1);
    expect(body.reputation.pendingConfirmationCount).toBe(1);
    expect(body.reputation.attestationRate).toBeCloseTo(0.5);
    expect(body.reputation.attestationCoverage).toBeCloseTo(2 / 3);

    // Breadth: two providers (1, 2), two distinct skills.
    expect(body.reputation.uniqueProviderCount).toBe(2);
    expect(body.reputation.uniqueSkillCount).toBe(2);

    // Fulfillment mean over the two attested rows.
    expect(body.reputation.averageFulfillmentSeconds).toBe(90);
    expect(body.reputation.fulfillmentSampleSize).toBe(2);

    expect(typeof body.firstPurchaseAt).toBe("string");
    expect(typeof body.lastPurchaseAt).toBe("string");
  });

  it("includes the buyer's most-recent purchases with provider+buyer names enriched", async () => {
    // Buyer 7 has an agentURI that resolves to a readable name; the
    // detail endpoint should pick it up the same way /activity does.
    const buyerCard = { name: "Alice the Buyer" };
    gateway.mockChain.setAgentURI(
      7n,
      `data:application/json,${encodeURIComponent(JSON.stringify(buyerCard))}`,
    );

    await seedPaid(gateway, {
      serviceRef: ("0x" + "11".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 10_000_000n,
      skillId: "register-domain",
      paymentId: 601n,
      txHash: ("0x" + "61".repeat(32)) as Hex,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers/7`);
    const body = (await res.json()) as any;
    expect(body.name).toBe("Alice the Buyer");
    expect(body.recentPurchases).toHaveLength(1);
    expect(body.recentPurchases[0]).toMatchObject({
      buyerAgentId: "7",
      providerAgentId: "1",
      providerName: "Acme Domains",
      buyerName: "Alice the Buyer",
      amount: "10.00",
      skillId: "register-domain",
    });
  });

  it("derives buyer-<wallet-suffix> when the buyer has a wallet but no agentURI", async () => {
    const wallet = "0xABd98f58eCA6e676E613C4001dd4c497fBAA39aA" as Hex;
    gateway.mockChain.setAgentWallet(42n, wallet);
    // No setAgentURI(42n, ...) — agentURI is empty.

    await seedPaid(gateway, {
      serviceRef: ("0x" + "22".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 42n,
      amountAtomic: 10_000_000n,
      skillId: "register-domain",
      paymentId: 701n,
      txHash: ("0x" + "71".repeat(32)) as Hex,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers/42`);
    const body = (await res.json()) as any;
    expect(body.name).toBe("buyer-aa39aa");
    expect(body.walletAddress?.toLowerCase()).toBe(wallet.toLowerCase());
  });
});

describe("public v1 — /buyers (leaderboard)", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Acme Domains",
          priceUsdcSmallest: "10000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("ranks buyers by lifetime USDC spend descending", async () => {
    // Buyer 7: 30 USDC across 2 txns. Buyer 8: 5 USDC across 1 txn.
    // Buyer 9: 100 USDC across 1 txn (top of leaderboard).
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a1".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 10_000_000n,
      paymentId: 801n,
      txHash: ("0x" + "81".repeat(32)) as Hex,
    });
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a2".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 7n,
      amountAtomic: 20_000_000n,
      paymentId: 802n,
      txHash: ("0x" + "82".repeat(32)) as Hex,
    });
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a3".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 8n,
      amountAtomic: 5_000_000n,
      paymentId: 803n,
      txHash: ("0x" + "83".repeat(32)) as Hex,
    });
    await seedPaid(gateway, {
      serviceRef: ("0x" + "a4".repeat(32)) as Hex,
      providerAgentId: 1n,
      buyerAgentId: 9n,
      amountAtomic: 100_000_000n,
      paymentId: 804n,
      txHash: ("0x" + "84".repeat(32)) as Hex,
    });

    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.buyers).toHaveLength(3);

    const [first, second, third] = body.buyers;
    expect(first.agentId).toBe("9");
    expect(first.totalSpentUsdc).toBe("100.00");
    expect(first.transactionCount).toBe(1);
    expect(second.agentId).toBe("7");
    expect(second.totalSpentUsdc).toBe("30.00");
    expect(second.transactionCount).toBe(2);
    expect(third.agentId).toBe("8");
    expect(third.totalSpentUsdc).toBe("5.00");
    expect(third.transactionCount).toBe(1);

    expect(typeof first.lastPurchaseAt).toBe("string");
  });

  it("honors the ?limit query param", async () => {
    for (let i = 0; i < 5; i++) {
      await seedPaid(gateway, {
        serviceRef: ("0x" +
          (i + 0xb0).toString(16).padStart(2, "0").repeat(32)) as Hex,
        providerAgentId: 1n,
        buyerAgentId: BigInt(100 + i),
        amountAtomic: BigInt((i + 1) * 1_000_000),
        paymentId: BigInt(900 + i),
        txHash: ("0x" +
          (i + 0x90).toString(16).padStart(2, "0").repeat(32)) as Hex,
      });
    }

    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers?limit=2`);
    const body = (await res.json()) as any;
    expect(body.buyers).toHaveLength(2);
  });

  it("returns an empty list when no settled rows exist", async () => {
    const res = await fetch(`${gateway.baseUrl}/public/v1/buyers`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.buyers).toEqual([]);
  });
});
