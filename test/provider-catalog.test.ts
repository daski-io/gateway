import { describe, expect, it } from "vitest";
import {
  findCatalogA2AEndpoint,
  isCatalogArtifactUrl,
  normalizeA2AUrl,
  skillMetaFromCard,
} from "../src/mcp/providerCatalog.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import type { DiscoveryCache } from "../src/discovery/cache.js";
import type { CachedProvider } from "../src/types.js";

const CARD = {
  supportedInterfaces: [{ url: "https://provider.test/A2A/" }],
  skills: [{ id: "listed-skill" }],
  extensions: {
    [DASKI_A2A_EXTENSION_URI]: {
      artifactOrigins: ["https://cdn.provider.test"],
      skills: {
        "listed-skill": { paymentRequired: true },
      },
    },
  },
};

const PROVIDER = {
  agentId: 7n,
  cards: [{ endpoint: "https://provider.test/card.json", agentCard: CARD }],
} as unknown as CachedProvider;

const CACHE = {
  getAll: () => [PROVIDER],
} as DiscoveryCache;

describe("provider catalog endpoint binding", () => {
  it("accepts only the advertised A2A endpoint", () => {
    expect(
      findCatalogA2AEndpoint(CACHE, "https://provider.test/A2A"),
    ).not.toBeNull();
    expect(
      findCatalogA2AEndpoint(CACHE, "https://provider.test/card.json"),
    ).toBeNull();
    expect(
      findCatalogA2AEndpoint(CACHE, "https://attacker.test/A2A"),
    ).toBeNull();
  });

  it("preserves case-sensitive paths and query strings", () => {
    expect(normalizeA2AUrl("HTTPS://Provider.Test/A2A/")).toBe(
      "https://provider.test/A2A",
    );
    expect(normalizeA2AUrl("https://provider.test/a2a")).not.toBe(
      normalizeA2AUrl("https://provider.test/A2A"),
    );
    expect(normalizeA2AUrl("https://provider.test/A2A?tenant=1")).not.toBe(
      normalizeA2AUrl("https://provider.test/A2A?tenant=2"),
    );
  });

  it("allows only provider and explicitly advertised artifact origins", () => {
    expect(
      isCatalogArtifactUrl(
        CACHE,
        "https://provider.test/A2A",
        "https://provider.test/files/result.pdf",
      ),
    ).toBe(true);
    expect(
      isCatalogArtifactUrl(
        CACHE,
        "https://provider.test/A2A",
        "https://cdn.provider.test/result.pdf",
      ),
    ).toBe(true);
    expect(
      isCatalogArtifactUrl(
        CACHE,
        "https://provider.test/A2A",
        "https://unrelated.test/result.pdf",
      ),
    ).toBe(false);
  });

  it("resolves skills only from the matched card", () => {
    expect(skillMetaFromCard(CARD, "listed-skill")).toEqual({
      paymentRequired: true,
    });
    expect(skillMetaFromCard(CARD, "missing-skill")).toBeNull();
  });
});
