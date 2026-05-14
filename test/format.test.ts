import { describe, expect, it } from "vitest";
import {
  extractAgentCardUrl,
  formatForSkillDiscover,
} from "../src/discovery/format.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import type { CachedProvider } from "../src/types.js";

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
    agentCard,
    providerName: null,
    providerDescription: null,
    providerImage: null,
    providerExternalUrl: null,
    lastFetched: new Date(),
    fetchError: null,
  };
}

const BASE_EXT = {
  pricing: { baseAmount: "10980000", currency: "USDC", variablePricing: true },
  category: "domain-management",
  serviceDescription: "Domains",
  serviceLifecycle: "asset-lifecycle",
};

describe("formatForSkillDiscover — skill extraction", () => {
  it("reads skill metadata from Shape B (extensions[URI].skills map) — daski-provider's actual shape", () => {
    const provider = makeProvider({
      name: "Domain Management",
      description: "x",
      url: "http://test/a2a",
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
              baseAmount: 10980000,
              priceList: { ".xyz": 2980000, ".io": 39990000 },
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

    const [svc] = formatForSkillDiscover([provider]);
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

  it("still reads Shape A (per-skill metadata) for providers that publish that way", () => {
    const provider = makeProvider({
      name: "Shape A Provider",
      description: "x",
      url: "http://test/a2a",
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

    const [svc] = formatForSkillDiscover([provider]);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0].paymentRequired).toBe(true);
    expect(skills[0].baseAmount).toBe("10.98");
  });

  it("emits skills with no metadata at all so they remain discoverable", () => {
    const provider = makeProvider({
      name: "Bare",
      description: "x",
      url: "http://test/a2a",
      skills: [
        { id: "solo", name: "Solo", description: "s" },
      ],
      extensions: {
        [DASKI_A2A_EXTENSION_URI]: { ...BASE_EXT },
      },
    });

    const [svc] = formatForSkillDiscover([provider]);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("solo");
    // Defaults applied when metadata is absent.
    expect(skills[0].paymentRequired).toBe(true);
    expect(skills[0].requiresCapability).toBe(false);
  });

  it("prefers Shape A when both A and B exist (per-skill metadata is authoritative)", () => {
    const provider = makeProvider({
      name: "Both",
      description: "x",
      url: "http://test/a2a",
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
            conflict: { paymentRequired: false, baseAmount: 999999 },
          },
        },
      },
    });

    const [svc] = formatForSkillDiscover([provider]);
    const skills = svc.skills as Array<Record<string, unknown>>;
    expect(skills[0].paymentRequired).toBe(true); // shape A wins
    expect(skills[0].baseAmount).toBe("5.00");
  });
});

describe("AgentCard URL extractor — A2A v1.0/v0.3 dual-read", () => {
  // Gateway sees both v0.3-shaped cards (`url` at root) and v1.0-shaped
  // ones (URL under `supportedInterfaces[0]`). These tests pin the
  // dual-read so a future cleanup that drops the legacy branch won't
  // quietly orphan pre-v1 providers. Provider-level icon/website are NO
  // LONGER read from the AgentCard — they live on the ERC-8004
  // registration file (cache.ts.resolveAgentCard), not here.
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

  it("falls back to top-level url when supportedInterfaces is absent (A2A v0.3)", () => {
    expect(extractAgentCardUrl({ url: "https://legacy.test/a2a" })).toBe(
      "https://legacy.test/a2a",
    );
  });

  it("returns null when neither shape carries a URL", () => {
    expect(extractAgentCardUrl({})).toBeNull();
    expect(extractAgentCardUrl({ supportedInterfaces: [] })).toBeNull();
    expect(extractAgentCardUrl({ supportedInterfaces: [{ url: "" }] })).toBeNull();
  });
});
