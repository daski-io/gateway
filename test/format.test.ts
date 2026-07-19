import { describe, expect, it } from "vitest";
import {
  extractAgentCardUrl,
  formatForSkillDiscover,
} from "../src/discovery/format.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import type { CachedProvider } from "../src/types.js";

const MARKETPLACE_LEGAL = {
  marketplaceTermsUrl: "https://daski.io/terms-of-use",
  marketplacePrivacyUrl: "https://daski.io/privacy-policy",
};

/**
 * Regression tests for the skill-metadata extraction used by
 * daski_discover. Two historical bugs this guards against:
 *   1. extractSkills only handled per-skill metadata (shape A), so
 *      daski-provider's extensions.URI.skills map (shape B) showed up as
 *      an empty skills array and agents couldn't see set-dns-record.
 *   2. It didn't expose requiresCapability, so agents couldn't tell they
 *      needed to sign a capability before calling a free skill.
 */

function makeProvider(
  agentCard: Record<string, unknown>,
): CachedProvider {
  return {
    agentId: 1n,
    walletAddress: "0x0000000000000000000000000000000000000001",
    agentURI: "http://test/agent.json",
    cards: [
      {
        endpoint: "https://test.example/a2a",
        serviceSlug: "test-service",
        agentCard,
      },
    ],
    providerName: null,
    providerDescription: null,
    providerImage: null,
    providerExternalUrl: null,
    providerLegal: {
      legalName: "Example Provider, LLC",
      termsUrl: "https://provider.example/terms",
      privacyUrl: "https://provider.example/privacy",
    },
    lastFetched: new Date(),
    fetchError: null,
  };
}

const BASE_EXT = {
  pricing: { baseAmount: "10980000", currency: "USDC", variablePricing: true },
  categoryFamily: "domains-web",
  serviceType: "domain-management",
  jurisdictions: ["global"],
  fulfillmentMode: "automated",
  serviceDescription: "Domains",
  serviceLifecycle: "asset-lifecycle",
};

describe("formatForSkillDiscover — skill extraction", () => {
  it("reads skill metadata from Shape B (extensions[URI].skills map) — daski-provider's actual shape", () => {
    const provider = makeProvider({
      name: "Domain Management",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        { id: "register-domain", name: "Register", description: "r" },
        { id: "set-dns-record", name: "Set DNS", description: "s" },
        { id: "list-dns-records", name: "List DNS", description: "l" },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: {
          ...BASE_EXT,
          skills: {
            "register-domain": {
              paymentRequired: true,
              variablePricing: true,
              pricing: {
                baseAmount: 10980000,
                priceList: { ".xyz": 2980000, ".io": 39990000 },
              },
              requiredFields: ["domain"],
              requiresAssetOwnership: false,
              requiresCapability: false,
            },
            "set-dns-record": {
              paymentRequired: false,
              requiresAssetOwnership: true,
              requiresCapability: true,
              requiredFields: ["domain", "recordType", "name", "content"],
            },
            "list-dns-records": {
              paymentRequired: false,
              requiresAssetOwnership: true,
              requiresCapability: false,
              requiredFields: ["domain"],
            },
          },
        },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    const byId = new Map(skills.map((s) => [s.id, s]));

    expect(skills).toHaveLength(3);

    const register = byId.get("register-domain")!;
    expect(register.paymentRequired).toBe(true);
    expect(register.baseAmount).toBe("10.98");
    expect(register.priceList).toEqual(
      expect.arrayContaining([
        { item: ".xyz", amount: "2.98" },
        { item: ".io", amount: "39.99" },
      ]),
    );

    // The skill that was silently missing from discover before this fix.
    const setDns = byId.get("set-dns-record")!;
    expect(setDns.paymentRequired).toBe(false);
    expect(setDns.requiresAssetOwnership).toBe(true);
    expect(setDns.requiresCapability).toBe(true);
    expect(setDns.requiredFields).toEqual([
      "domain",
      "recordType",
      "name",
      "content",
    ]);

    const list = byId.get("list-dns-records")!;
    expect(list.paymentRequired).toBe(false);
    expect(list.requiresCapability).toBe(false);
  });

  it("ignores obsolete per-skill metadata in favor of extension.skills", () => {
    const provider = makeProvider({
      name: "Shape A Provider",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        {
          id: "register-domain",
          name: "Register",
          description: "r",
          metadata: {
            [DASKI_A2A_EXTENSION_URI]: {
              paymentRequired: true,
              baseAmount: 10980000,
              requiredFields: ["domain"],
            },
          },
        },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: { ...BASE_EXT },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    // The skill remains discoverable, but obsolete metadata cannot alter
    // the current marketplace contract.
    expect(skills[0].paymentRequired).toBe(true);
    expect(skills[0].baseAmount).toBeUndefined();
  });

  it("emits skills with no metadata at all so they remain discoverable", () => {
    const provider = makeProvider({
      name: "Bare",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        { id: "solo", name: "Solo", description: "s" },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: { ...BASE_EXT },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("solo");
    // Defaults applied when metadata is absent.
    expect(skills[0].paymentRequired).toBe(true);
    expect(skills[0].requiresCapability).toBe(false);
  });

  // §3.2 of daski-mcp-gateway-fix-brief.md — surface optionalFields and
  // the two-call callPhases block from the provider's per-skill metadata.
  it("surfaces optionalFields and callPhases when the provider declares them", () => {
    const provider = makeProvider({
      name: "Two-call provider",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        { id: "set-dns-record", name: "Set DNS", description: "s" },
        { id: "renew-domain", name: "Renew", description: "r" },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: {
          ...BASE_EXT,
          skills: {
            "set-dns-record": {
              paymentRequired: false,
              requiresAssetOwnership: true,
              requiresCapability: true,
              capabilityType: "DnsSetRecordAuthorization",
              requiredFields: ["domain", "recordType", "name", "content"],
              optionalFields: ["ttl", "priority", "capability"],
              callPhases: {
                challenge: {
                  description: "Omit `capability`. Returns typed-data to sign.",
                  requiredFields: [
                    "domain",
                    "recordType",
                    "name",
                    "content",
                  ],
                  optionalFields: ["ttl", "priority"],
                },
                execute: {
                  description:
                    "Include `capability: { signature, authorization }`.",
                  requiredFields: [
                    "domain",
                    "recordType",
                    "name",
                    "content",
                    "capability",
                  ],
                  optionalFields: ["ttl", "priority"],
                },
              },
            },
            "renew-domain": {
              paymentRequired: true,
              variablePricing: true,
              requiredFields: ["domain"],
              optionalFields: ["term"],
            },
          },
        },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    const byId = new Map(skills.map((s) => [s.id, s]));

    const setDns = byId.get("set-dns-record")!;
    expect(setDns.optionalFields).toEqual(["ttl", "priority", "capability"]);
    expect(setDns.capabilityType).toBe("DnsSetRecordAuthorization");
    const callPhases = setDns.callPhases as Record<string, Record<string, unknown>>;
    expect(callPhases.challenge.requiredFields).toEqual([
      "domain",
      "recordType",
      "name",
      "content",
    ]);
    expect(callPhases.execute.requiredFields).toContain("capability");

    const renew = byId.get("renew-domain")!;
    expect(renew.optionalFields).toEqual(["term"]);
    // Non-gated skills shouldn't grow a callPhases block.
    expect(renew.callPhases).toBeUndefined();
  });

  // §1.7 of daski-mcp-gateway-fix-brief.md — the default 1KB string cap
  // was clipping the 6-element-template skill descriptions. We raise the
  // per-string cap inside the skills array specifically so the
  // operational detail (When NOT to use, capability flow, Returns, Next
  // step) survives the round-trip.
  it("preserves long skill descriptions past the default 1KB cap", () => {
    const longDescription = "x".repeat(3500);
    const provider = makeProvider({
      name: "Verbose",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        { id: "register-domain", name: "Register", description: longDescription },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: {
          ...BASE_EXT,
          skills: {
            "register-domain": { paymentRequired: true },
          },
        },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(typeof skills[0].description).toBe("string");
    expect((skills[0].description as string).length).toBe(3500);
  });

  it("uses extension.skills when obsolete inline metadata conflicts", () => {
    const provider = makeProvider({
      name: "Both",
      description: "x",
      supportedInterfaces: [{ url: "http://test/a2a" }],
      skills: [
        {
          id: "conflict",
          name: "Conflict",
          description: "c",
          metadata: {
            [DASKI_A2A_EXTENSION_URI]: {
              paymentRequired: true,
              baseAmount: 5000000,
            },
          },
        },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: {
          ...BASE_EXT,
          skills: {
            conflict: {
              paymentRequired: false,
              pricing: { baseAmount: 999999 },
            },
          },
        },
      },
    });

    const [svc] = formatForSkillDiscover([provider], MARKETPLACE_LEGAL);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills[0].paymentRequired).toBe(false);
    expect(skills[0].baseAmount).toBe("1.00");
  });
});

describe("AgentCard URL extractor — A2A v1.0", () => {
  it("reads url from supportedInterfaces[0] when present (A2A v1.0)", () => {
    expect(
      extractAgentCardUrl({
        supportedInterfaces: [
          {
            url: "https://prov.test/a2a/foo",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
      }),
    ).toBe("https://prov.test/a2a/foo");
  });

  it("rejects obsolete top-level URL fields", () => {
    expect(extractAgentCardUrl({ url: "https://legacy.test/a2a" })).toBeNull();
  });

  it("returns null when neither shape carries a URL", () => {
    expect(extractAgentCardUrl({})).toBeNull();
    expect(extractAgentCardUrl({ supportedInterfaces: [] })).toBeNull();
    expect(extractAgentCardUrl({ supportedInterfaces: [{ url: "" }] })).toBeNull();
  });
});
