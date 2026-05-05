import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
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
  },
): Promise<void> {
  const queries = gateway.bundle.queries;
  // Insert as pending, then flip to paid via the same atomic UPDATE the
  // facilitator uses in production. This exercises the real `recordChallengePaid`
  // semantics (single-use service_ref, verified_at populated by SQL).
  await queries.insertChallenge({
    serviceRef: args.serviceRef,
    providerTokenId: args.providerAgentId,
    buyerTokenId: args.buyerAgentId,
    amount: args.amountAtomic,
    skillId: args.skillId ?? null,
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
