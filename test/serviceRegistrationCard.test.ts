import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/standardRail/canonical.js";
import {
  parseProviderServiceCard,
} from "../src/serviceRegistration/card.js";
import {
  listingReuseScopeHash,
} from "../src/serviceRegistration/preparation.js";

const serviceId = `0x${"1".repeat(64)}` as const;

function card(overrides: {
  paymentRequired?: boolean;
  categoryFamily?: string;
  assetAction?: Record<string, unknown> | null;
  requiresAssetOwnership?: boolean;
  maxOpenOrders?: number;
} = {}) {
  const contract = {
    inputSchema: {
      type: "object",
      properties: { destination: { type: "string" } },
      required: ["destination"],
      additionalProperties: false,
    },
    resultSchema: {
      type: "object",
      properties: { accepted: { type: "boolean" } },
      required: ["accepted"],
      additionalProperties: false,
    },
    pricing: {
      USDC: {
        type: "one-time",
        fixed_amount: overrides.paymentRequired === false ? "0" : "1250000",
      },
    },
    paymentRequired: overrides.paymentRequired ?? true,
    requiresAssetOwnership: overrides.requiresAssetOwnership ?? false,
    assetType: overrides.requiresAssetOwnership ? "orbital-slot" : null,
    fulfillmentMode: "hybrid",
    capacity: { maxOpenOrders: overrides.maxOpenOrders ?? 17 },
    deadlines: { dispatchSeconds: 300 },
    assetAction: overrides.assetAction ?? null,
  };
  const skillContractHash = canonicalHash({
    schemaVersion: 1,
    serviceSlug: "orbital-logistics",
    serviceVersion: "1",
    skillId: "reserve-orbit",
    contract,
  });
  const skillContractSetHash = canonicalHash([{
    skillId: "reserve-orbit",
    skillContractHash,
  }]);
  return {
    name: "Orbital Logistics",
    description: "A deliberately novel provider category.",
    extensions: {
      "https://daski.xyz/a2a/v1": {
        legal: {
          marketplaceTermsUrl: "https://daski.example/terms",
          marketplacePrivacyUrl: "https://daski.example/privacy",
          providerLegalName: "Orbital Logistics LLC",
          providerTermsUrl: "https://provider.example/terms",
          providerPrivacyUrl: "https://provider.example/privacy",
        },
      },
      "https://daski.xyz/a2a/v2": {
        schemaVersion: 1,
        providerAgentId: "42",
        service: {
          serviceId,
          slug: "orbital-logistics",
          version: "1",
          categoryFamily: overrides.categoryFamily ?? "space-operations",
          serviceType: "orbit-reservation",
          jurisdictions: ["LEO"],
          lifecycle: "asset-lifecycle",
          turnaroundEstimate: "1 day",
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
        skillContractSetHash,
        skills: [{
          skillId: "reserve-orbit",
          skillContractHash,
          acceptingNewOrders: true,
          presentation: {
            name: "Reserve orbit",
            description: "Reserve an orbital slot.",
            examples: ["Reserve LEO-17"],
            tags: ["space"],
            documentationUrl: "https://provider.example/skills/reserve-orbit.md",
          },
          contract,
        }],
      },
    },
  };
}

const expected = {
  providerAgentId: "42",
  serviceId,
  serviceSlug: "orbital-logistics",
  serviceVersion: "1",
  agentCardUrl: "https://provider.example/agent-cards/orbital-logistics.json",
};

describe("provider service-card admission", () => {
  it("admits arbitrary bounded taxonomy and derives paid status from USDC pricing", () => {
    const parsed = parseProviderServiceCard(card(), expected);
    expect(parsed.service.categoryFamily).toBe("space-operations");
    expect(parsed.skills[0]?.contract.paymentRequired).toBe(true);
  });

  it("rejects a duplicate payment flag that contradicts pricing", () => {
    const raw = card({ paymentRequired: false });
    const extension = raw.extensions["https://daski.xyz/a2a/v2"];
    extension.skills[0]!.contract.pricing.USDC.fixed_amount = "100";
    expect(() => parseProviderServiceCard(raw, expected))
      .toThrow("paymentRequired does not match");
  });

  it("rejects a fixed amount combined with another amount mechanism", () => {
    const raw = card({ paymentRequired: false });
    const pricing = raw.extensions["https://daski.xyz/a2a/v2"]
      .skills[0]!.contract.pricing.USDC as Record<string, unknown>;
    pricing.min_amount = "1";
    expect(() => parseProviderServiceCard(raw, expected))
      .toThrow(
        "fixed_amount cannot be combined with another amount mechanism",
      );
  });

  it("fails closed on unclassified action fields", () => {
    const raw = card({
      requiresAssetOwnership: true,
      assetAction: {
        ownershipPolicy: "owner-only",
        effect: "mutate",
        replayPolicy: "stable-result",
        retentionSeconds: 3600,
        silentlyUnsafe: true,
      },
    });
    expect(() => parseProviderServiceCard(raw, expected))
      .toThrow("asset action fields are invalid");
  });

  it("refreshes presentation without changing the signed service contract", () => {
    const first = parseProviderServiceCard(card(), expected);
    const refreshed = card();
    refreshed.name = "Orbital Logistics — Updated";
    refreshed.description = "New presentation copy.";
    refreshed.extensions["https://daski.xyz/a2a/v2"].service.turnaroundEstimate =
      "two orbits";

    expect(parseProviderServiceCard(refreshed, expected).serviceContractHash)
      .toBe(first.serviceContractHash);
  });

  it("changes the signed service contract when legal terms change", () => {
    const first = parseProviderServiceCard(card(), expected);
    const changed = card();
    changed.extensions["https://daski.xyz/a2a/v1"].legal.providerTermsUrl =
      "https://provider.example/revised-terms";
    expect(parseProviderServiceCard(changed, expected).serviceContractHash)
      .not.toBe(first.serviceContractHash);
  });

  it("lets individual skill hashes decide reuse when only one skill changes", () => {
    const first = parseProviderServiceCard(card(), expected);
    const oneSkillChanged = parseProviderServiceCard(
      card({ maxOpenOrders: 18 }),
      expected,
    );
    expect(oneSkillChanged.serviceContractHash).not.toBe(first.serviceContractHash);
    expect(listingReuseScopeHash(oneSkillChanged))
      .toBe(listingReuseScopeHash(first));
  });
});
