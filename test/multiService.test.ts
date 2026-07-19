import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import type {
  CategoryFamily,
  ServiceType,
} from "../src/serviceTaxonomy.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

// Multi-service providers: one ERC-8004 registration file listing SEVERAL
// `services[name="A2A"]` entries — one Agent Card per service. The
// gateway must fetch every card, surface one catalog entry per
// (provider, service), rank them independently in intent search, and
// route skill-scoped flows at the right card. Mirrors the real-world
// daski-provider deployment (domain-management + mailboxes).

async function connectClient(baseUrl: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
}

function parseResult<T>(result: unknown): T {
  const r = result as ToolResultContent;
  expect(r.content?.[0]).toBeDefined();
  return JSON.parse(r.content[0]!.text) as T;
}

function expectedLegal(gateway: TestGateway) {
  return {
    marketplaceTermsUrl: gateway.config.marketplaceTermsUrl,
    marketplacePrivacyUrl: gateway.config.marketplacePrivacyUrl,
    providerLegalName: "Blue T Group, LLC",
    providerTermsUrl: "https://bluetgroup.com/service-provider-terms-of-use",
    providerPrivacyUrl:
      "https://bluetgroup.com/service-provider-privacy-policy",
  };
}

interface SkillDef {
  id: string;
  name: string;
  description: string;
  paid: boolean;
  baseAmount?: string;
  fulfillmentMode?: "automated" | "human" | "hybrid";
}

function buildCard(args: {
  base: string;
  name: string;
  slug: string;
  categoryFamily: CategoryFamily;
  serviceType: ServiceType;
  jurisdictions?: string[];
  description: string;
  skills: SkillDef[];
}): Record<string, unknown> {
  const paidSkills = args.skills.filter((s) => s.paid && s.baseAmount);
  return {
    name: args.name,
    supportedInterfaces: [
      {
        url: `${args.base}/a2a/${args.slug}`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    skills: args.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    })),
    extensions: {
      [DASKI_A2A_EXTENSION_URI]: {
        pricing: {
          currency: "USDC",
          variablePricing: false,
          billingModel: "one-time",
          ...(paidSkills[0]?.baseAmount
            ? { baseAmount: paidSkills[0].baseAmount }
            : {}),
        },
        categoryFamily: args.categoryFamily,
        serviceType: args.serviceType,
        jurisdictions: args.jurisdictions ?? ["global"],
        serviceDescription: args.description,
        serviceLifecycle: "asset-lifecycle",
        // Shape B skill metadata (what daski-provider serves today).
        // NOTE: the fixed amount is NESTED under meta.pricing — exactly
        // how daski-provider's generator emits it — so these tests
        // exercise the gateway's nested-pricing fallback. Free skills
        // carry the translated "0", which readers must treat as absent.
        skills: Object.fromEntries(
          args.skills.map((s) => [
            s.id,
            {
              serviceSlug: args.slug,
              serviceVersion: "1",
              fulfillmentMode: s.fulfillmentMode ?? "automated",
              paymentRequired: s.paid,
              pricing: {
                type: "one-time",
                baseAmount: s.baseAmount ?? "0",
              },
            },
          ]),
        ),
      },
    },
  };
}

describe("multi-service providers", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          name: "Placeholder",
          priceUsdcSmallest: "15000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
        },
      ],
    });

    const base = gateway.mockProvider.baseUrl;
    // Two-service registration file, mirroring daski-provider's layout.
    gateway.mockProvider.setAgentCard("/reg/1.json", {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Blue T Group, LLC",
      description: "Independent provider serving the AI agent economy.",
      legalName: "Blue T Group, LLC",
      termsUrl: "https://bluetgroup.com/service-provider-terms-of-use",
      privacyUrl: "https://bluetgroup.com/service-provider-privacy-policy",
      services: [
        { name: "A2A", endpoint: `${base}/cards/domains.json`, version: "1.0.0" },
        { name: "A2A", endpoint: `${base}/cards/mailboxes.json`, version: "1.0.0" },
      ],
      x402Support: true,
      active: true,
      registrations: [],
    });
    gateway.mockProvider.setAgentCard(
      "/cards/domains.json",
      buildCard({
        base,
        name: "Domain Management",
        slug: "domain-management",
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        description: "Register and manage domain names with automated DNS setup.",
        skills: [
          {
            id: "register-domain",
            name: "Register Domain",
            description: "Register a new domain name at the wholesale registrar.",
            paid: true,
            baseAmount: "15000000",
          },
          {
            id: "check-availability",
            name: "Check Domain Availability",
            description: "Check whether a domain name is available for registration.",
            paid: false,
          },
        ],
      }),
    );
    gateway.mockProvider.setAgentCard(
      "/cards/mailboxes.json",
      buildCard({
        base,
        name: "Agent Mailboxes",
        slug: "mailboxes",
        categoryFamily: "communications",
        serviceType: "agent-mailbox",
        description: "Working email mailboxes for agents over IMAP and SMTP.",
        skills: [
          {
            id: "create-mailbox",
            name: "Create Mailbox",
            description: "Provision an email mailbox with IMAP SMTP credentials.",
            paid: true,
            baseAmount: "9990000",
            fulfillmentMode: "human",
          },
          {
            // Deliberate skill-id collision with the domains card —
            // skill ids are only unique within a service.
            id: "check-availability",
            name: "Check Mailbox Availability",
            description: "Check whether a mailbox email address is available.",
            paid: false,
          },
        ],
      }),
    );
    gateway.mockChain.addProvider(1n, {
      walletAddress: "0x0000000000000000000000000000000000000001",
      agentId: 1n,
      agentURI: `${base}/reg/1.json`,
      registrationTime: 1n,
      isActive: true,
    });
    await gateway.refresh();
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("caches every advertised card (REST /discover exposes cards[])", async () => {
    const { status, json } = await gateway.discover();
    expect(status).toBe(200);
    const provider = json.providers.find((p: any) => p.tokenId === "1");
    expect(provider.fetchError).toBeNull();
    expect(provider.cards).toHaveLength(2);
    const slugs = provider.cards.map((c: any) => c.serviceSlug).sort();
    expect(slugs).toEqual(["domain-management", "mailboxes"]);
    expect(provider.legal).toEqual(expectedLegal(gateway));
    expect(
      provider.cards[0].agentCard.extensions[DASKI_A2A_EXTENSION_URI].legal,
    ).toEqual(expectedLegal(gateway));
    for (const card of provider.cards) {
      expect(card.legal).toEqual(expectedLegal(gateway));
      expect(card.agentCard.extensions[DASKI_A2A_EXTENSION_URI].legal).toEqual(
        expectedLegal(gateway),
      );
    }
    // Back-compat: agentCard remains the first card.
    expect(provider.cards[0].agentCard.name).toBe("Domain Management");
  });

  it("catalog mode surfaces one entry per service with its own A2A endpoint", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {},
      });
      const body = parseResult<{
        providers: Array<{
          tokenId: string;
          name: string;
          serviceSlug: string | null;
          providerA2AUrl: string;
          legal: Record<string, string>;
          skills: Array<{ id: string }>;
        }>;
      }>(result);

      const mine = body.providers.filter((p) => p.tokenId === "1");
      expect(mine).toHaveLength(2);
      const bySlug = new Map(mine.map((p) => [p.serviceSlug, p]));
      for (const service of mine) {
        expect(service.legal).toEqual(expectedLegal(gateway));
      }
      expect(bySlug.get("domain-management")!.name).toBe("Domain Management");
      expect(bySlug.get("mailboxes")!.name).toBe("Agent Mailboxes");
      expect(bySlug.get("mailboxes")!.providerA2AUrl).toMatch(/\/a2a\/mailboxes$/);
      expect(bySlug.get("domain-management")!.providerA2AUrl).toMatch(
        /\/a2a\/domain-management$/,
      );
      // The colliding free skill appears on BOTH services, each namespaced.
      expect(
        bySlug.get("mailboxes")!.skills.map((s) => s.id),
      ).toContain("check-availability");
      expect(
        bySlug.get("domain-management")!.skills.map((s) => s.id),
      ).toContain("check-availability");
      // Fixed price surfaces from the NESTED meta.pricing.baseAmount
      // (the shape daski-provider emits); the free skill's translated
      // "0" must NOT surface as a $0.00 price.
      const mailboxSkills = bySlug.get("mailboxes")!.skills as Array<{
        id: string;
        baseAmount?: string;
      }>;
      expect(
        mailboxSkills.find((s) => s.id === "create-mailbox")?.baseAmount,
      ).toBe("9.99");
      expect(
        mailboxSkills.find((s) => s.id === "check-availability")?.baseAmount,
      ).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it("intent search ranks each service independently", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: { intent: "email mailbox imap smtp for my agent", limit: 5 },
      });
      const body = parseResult<{
        providers: Array<{
          tokenId: string;
          serviceSlug: string | null;
          match: { distance: number; bestSkillId: string };
        }>;
      }>(result);

      expect(body.providers.length).toBeGreaterThanOrEqual(1);
      // The mailbox SERVICE must rank first for a mailbox intent — before
      // the same provider's domain service (pre-fix, the provider
      // collapsed to one entry dominated by the domain card).
      const first = body.providers[0]!;
      expect(first.tokenId).toBe("1");
      expect(first.serviceSlug).toBe("mailboxes");
      expect(["create-mailbox", "check-availability"]).toContain(
        first.match.bestSkillId,
      );
    } finally {
      await transport.close();
    }
  });

  it("keeps near misses when structured filters exclude every card", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {
          intent: "email mailbox imap smtp for my agent",
          categoryFamily: "compute-ai",
        },
      });
      const body = parseResult<{
        providers: unknown[];
        nearMisses: Array<{ serviceSlug: string | null }>;
      }>(result);
      expect(body.providers).toEqual([]);
      expect(body.nearMisses.map((entry) => entry.serviceSlug)).toContain(
        "mailboxes",
      );
    } finally {
      await transport.close();
    }
  });

  it("ranks only skills eligible for the requested fulfillment mode", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: {
          intent: "create an email mailbox with imap and smtp",
          categoryFamily: "communications",
          fulfillmentMode: "automated",
        },
      });
      const body = parseResult<{
        providers: Array<{
          serviceSlug: string | null;
          match: { bestSkillId: string };
        }>;
      }>(result);
      expect(body.providers[0]!.serviceSlug).toBe("mailboxes");
      expect(body.providers[0]!.match.bestSkillId).toBe("check-availability");
    } finally {
      await transport.close();
    }
  });

  it("category-family filter selects individual services of one provider", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = await client.callTool({
        name: "daski_search_services",
        arguments: { categoryFamily: "communications" },
      });
      const body = parseResult<{
        providers: Array<{ tokenId: string; serviceSlug: string | null }>;
      }>(result);
      const mine = body.providers.filter((p) => p.tokenId === "1");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.serviceSlug).toBe("mailboxes");
    } finally {
      await transport.close();
    }
  });

  it("rejects the removed MCP category filter", async () => {
    const { client, transport } = await connectClient(gateway.baseUrl);
    try {
      const result = (await client.callTool({
        name: "daski_search_services",
        arguments: { category: "email" },
      })) as ToolResultContent & { isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/category/i);
    } finally {
      await transport.close();
    }
  });

  it("public site lists both services and serves per-slug detail", async () => {
    const list = await fetch(`${gateway.baseUrl}/public/v1/services`);
    expect(list.status).toBe(200);
    const listBody: any = await list.json();
    const mine = listBody.services.filter((s: any) => s.agentId === "1");
    for (const service of mine) {
      expect(service.legal).toEqual(expectedLegal(gateway));
    }
    expect(mine.map((s: any) => s.serviceSlug).sort()).toEqual([
      "domain-management",
      "mailboxes",
    ]);

    // Detail response is the flat PublicService shape + reputation blocks.
    const detail = await fetch(
      `${gateway.baseUrl}/public/v1/services/1?service=mailboxes`,
    );
    expect(detail.status).toBe(200);
    const svc: any = await detail.json();
    expect(svc.serviceSlug).toBe("mailboxes");
    expect(svc.name).toBe("Agent Mailboxes");

    // Multi-service detail requests must identify the service explicitly.
    const ambiguous = await fetch(`${gateway.baseUrl}/public/v1/services/1`);
    expect(ambiguous.status).toBe(404);
  });

  it("x402-services.json advertises paid skills from every card", async () => {
    const res = await fetch(`${gateway.baseUrl}/.well-known/x402-services.json`);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const mine = body.services.filter((s: any) => s.providerTokenId === "1");
    const skillIds = mine.map((s: any) => s.skillId).sort();
    expect(skillIds).toEqual(["create-mailbox", "register-domain"]);
    const mailbox = mine.find((s: any) => s.skillId === "create-mailbox");
    expect(mailbox.providerA2AUrl).toMatch(/\/a2a\/mailboxes$/);
    expect(mailbox.maxAmountRequired).toBe("9990000");
    expect(mailbox.legal).toEqual(expectedLegal(gateway));
  });

  it("tolerates one broken card without delisting the healthy ones", async () => {
    const base = gateway.mockProvider.baseUrl;
    gateway.mockProvider.setAgentCard("/reg/1.json", {
      name: "Blue T Group, LLC",
      legalName: "Blue T Group, LLC",
      termsUrl: "https://bluetgroup.com/service-provider-terms-of-use",
      privacyUrl: "https://bluetgroup.com/service-provider-privacy-policy",
      services: [
        { name: "A2A", endpoint: `${base}/cards/domains.json`, version: "1.0.0" },
        { name: "A2A", endpoint: "http://127.0.0.1:1/nowhere.json", version: "1.0.0" },
      ],
      x402Support: true,
      active: true,
      registrations: [],
    });
    await gateway.refresh();

    const { json } = await gateway.discover();
    const provider = json.providers.find((p: any) => p.tokenId === "1");
    expect(provider.cards).toHaveLength(1);
    expect(provider.cards[0].serviceSlug).toBe("domain-management");
    expect(provider.fetchError).toMatch(/partial card fetch/);
  });
});
