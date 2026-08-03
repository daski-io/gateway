import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import type { DiscoveryCache } from "../src/discovery/cache.js";
import { runBuyServiceFreePath } from "../src/mcp/buyServiceFree.js";
import type { BuyServiceContext } from "../src/mcp/buyServiceTypes.js";
import {
  ProviderAuthorityError,
  type ProviderAuthorityService,
} from "../src/payment/providerAuthority.js";
import type { CachedProvider } from "../src/types.js";

const SKILL_META = {
  paymentRequired: false,
  requiresAssetOwnership: false,
  requiresCapability: false,
  directEndpoint: "/availability",
  directResultKind: "availability",
};

const AGENT_CARD = {
  supportedInterfaces: [{ url: "https://provider.test/a2a" }],
  skills: [{ id: "check-availability" }],
  extensions: {
    [DASKI_A2A_EXTENSION_URI]: {
      skills: { "check-availability": SKILL_META },
    },
  },
};

const PROVIDER = {
  agentId: 7n,
  cards: [
    {
      endpoint: "https://provider.test/card.json",
      serviceSlug: "domain-management",
      agentCard: AGENT_CARD,
    },
  ],
} as unknown as CachedProvider;

const CONTEXT: BuyServiceContext = {
  args: {
    skillId: "check-availability",
    serviceSlug: "domain-management",
    walletAddress: "0x1111111111111111111111111111111111111111",
    providerTokenId: "7",
    serviceArgs: { domain: "example.test" },
  },
  provider: {
    agentId: 7n,
    serviceSlug: "domain-management",
    skillMeta: SKILL_META,
    agentCard: AGENT_CARD,
  },
  providerA2AUrl: "https://provider.test/a2a",
  serviceArgs: { domain: "example.test" },
  buyerAgentId: 0n,
};

describe("free service provider authority", () => {
  it("fails closed before direct dispatch when authority is unavailable", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const providerAuthority = {
      requireFresh: vi.fn().mockRejectedValue(
        new ProviderAuthorityError("provider_authority_unavailable"),
      ),
    } as unknown as ProviderAuthorityService;
    const result = await runBuyServiceFreePath(CONTEXT, {
      config: { chainId: 84532, network: "base-sepolia" } as Config,
      cache: { getAll: () => [PROVIDER] } as DiscoveryCache,
      providerAuthority,
      fetch: fetchFn,
      timeoutMs: 1_000,
      maxResponseBytes: 64 * 1024,
    });

    const content = result.content[0] as { type: "text"; text: string };
    expect(JSON.parse(content.text)).toMatchObject({
      code: "PROVIDER_AUTHORITY_UNAVAILABLE",
    });
    expect(providerAuthority.requireFresh).toHaveBeenCalledWith(7n);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("dispatches only after authority and the catalog binding are fresh", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ domain: "example.test", available: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const providerAuthority = {
      requireFresh: vi.fn().mockResolvedValue({ agentId: 7n }),
    } as unknown as ProviderAuthorityService;
    const result = await runBuyServiceFreePath(CONTEXT, {
      config: { chainId: 84532, network: "base-sepolia" } as Config,
      cache: { getAll: () => [PROVIDER] } as DiscoveryCache,
      providerAuthority,
      fetch: fetchFn,
      timeoutMs: 1_000,
      maxResponseBytes: 64 * 1024,
    });

    const content = result.content[0] as { type: "text"; text: string };
    expect(JSON.parse(content.text)).toMatchObject({
      status: "completed",
      kind: "availability",
      untrustedProviderContent: {
        domain: "example.test",
        available: true,
      },
    });
    expect(providerAuthority.requireFresh).toHaveBeenCalledWith(7n);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://provider.test/availability",
      expect.objectContaining({ method: "POST" }),
      undefined,
    );
  });
});
