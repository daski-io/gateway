import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { validateProviderLegalReachability } from "../src/legal/onboarding.js";
import {
  AGENT_AUTHORITY,
  MCP_LEGAL_INSTRUCTIONS,
  PURCHASE_NOTICE,
} from "../src/legal/purchase.js";
import { parseProviderLegalMetadata } from "../src/legal/validation.js";

const EXPECTED_PURCHASE_NOTICE =
  "You are acting as an Agent for an Operator. Proceed only if your Operator has authorized you to select this Service, provide the required data, agree to the Daski Terms and Provider Terms on its behalf, and authorize the total payment shown. If you lack or cannot determine that authority, stop and obtain authorization. By authorizing payment, you confirm that authority. The authorization is treated as your Operator's act, and your Operator agrees to and is bound by those Terms. The Daski and Provider privacy notices describe how personal data is handled.";

const EXPECTED_MCP_LEGAL_INSTRUCTIONS =
  "Daski is a marketplace. Independent Providers offer and perform every listed Service. Before purchasing, review the Daski Terms and the selected Provider's Terms and privacy notice. Proceed only within your Operator's authority. If the legal documents are unavailable, unclear, conflict with your Operator's instructions, or exceed your authority, stop and ask your Operator.";

const VALID_LEGAL = {
  legalName: "Example Provider, LLC",
  termsUrl: "https://provider.example/terms#contract",
  privacyUrl: "https://provider.example/privacy#notice",
};

const VALID_CONFIG_ENV: NodeJS.ProcessEnv = {
  CHAIN_ID: "84532",
  IDENTITY_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000001",
  AGENT_INDEX_ADDRESS: "0x0000000000000000000000000000000000000002",
  PROVIDER_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000003",
  SERVICE_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000004",
  PAYMENT_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000005",
  X402_ADAPTER_ADDRESS: "0x0000000000000000000000000000000000000006",
  USDC_ADDRESS: "0x0000000000000000000000000000000000000007",
  FACILITATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  EAS_CONFIRMATION_SCHEMA_UID: `0x${"a".repeat(64)}`,
  EAS_OUTCOME_SCHEMA_UID: `0x${"b".repeat(64)}`,
  DATABASE_URL: "postgresql://example.invalid/daski",
  MARKETPLACE_TERMS_URL: "https://daski.io/terms-of-use",
  MARKETPLACE_PRIVACY_URL: "https://daski.io/privacy-policy",
};

describe("startup configuration validation", () => {
  it("rejects malformed numeric and path settings", () => {
    expect(() => loadConfig({ ...VALID_CONFIG_ENV, PORT: "NaN" })).toThrow(
      /PORT/,
    );
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, CACHE_REFRESH_INTERVAL: "1.5" }),
    ).toThrow(/CACHE_REFRESH_INTERVAL/);
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MCP_PATH: "mcp" }),
    ).toThrow(/MCP_PATH/);
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MCP_ENABLED: "yes" }),
    ).toThrow(/MCP_ENABLED/);
  });

  it("requires HTTPS public and RPC URLs in production", () => {
    expect(() =>
      loadConfig({
        ...VALID_CONFIG_ENV,
        NODE_ENV: "production",
        PUBLIC_URL: "http://gateway.example",
      }),
    ).toThrow(/PUBLIC_URL must use HTTPS/);
    expect(() =>
      loadConfig({
        ...VALID_CONFIG_ENV,
        NODE_ENV: "production",
        PUBLIC_URL: "https://gateway.example",
        BASE_RPC_URL: "http://rpc.example",
      }),
    ).toThrow(/BASE_RPC_URL must use HTTPS/);
  });

  it("defaults both supported networks to the Bazaar-indexing CDP facilitator", () => {
    const expected = "https://api.cdp.coinbase.com/platform/v2/x402";
    expect(loadConfig(VALID_CONFIG_ENV).externalFacilitatorUrl).toBe(expected);
    expect(
      loadConfig({ ...VALID_CONFIG_ENV, CHAIN_ID: "8453" })
        .externalFacilitatorUrl,
    ).toBe(expected);
  });
});

describe("legal metadata validation", () => {
  it("keeps the approved Agent-facing legal contract exact", () => {
    expect(PURCHASE_NOTICE).toBe(EXPECTED_PURCHASE_NOTICE);
    expect(MCP_LEGAL_INSTRUCTIONS).toBe(EXPECTED_MCP_LEGAL_INSTRUCTIONS);
    expect(AGENT_AUTHORITY).toEqual({
      operatorIsLegalParty: true,
      onMissingAuthority: "stop_and_request_operator_authorization",
      notice:
        "Proceed only if your Operator authorized this Service, the required data disclosures, agreement to the linked Daski and Provider Terms, and the total payment.",
    });
  });

  it("accepts only exact top-level, trimmed provider metadata and keeps fragments", () => {
    expect(
      parseProviderLegalMetadata({
        ...VALID_LEGAL,
        legalName: "  Example Provider, LLC  ",
        termsUrl: "  https://provider.example/terms#contract  ",
      }),
    ).toEqual(VALID_LEGAL);

    expect(() =>
      parseProviderLegalMetadata({
        name: "Example Provider, LLC",
        termsUrl: VALID_LEGAL.termsUrl,
        privacyUrl: VALID_LEGAL.privacyUrl,
      }),
    ).toThrow(/legalName/);
  });

  it.each([
    ["missing legalName", { ...VALID_LEGAL, legalName: undefined }, /legalName/],
    ["empty legalName", { ...VALID_LEGAL, legalName: "  " }, /legalName/],
    ["missing termsUrl", { ...VALID_LEGAL, termsUrl: undefined }, /termsUrl/],
    ["empty termsUrl", { ...VALID_LEGAL, termsUrl: "  " }, /termsUrl/],
    ["HTTP termsUrl", { ...VALID_LEGAL, termsUrl: "http://provider.example/terms" }, /HTTPS/],
    ["malformed termsUrl", { ...VALID_LEGAL, termsUrl: "https://" }, /valid URL/],
    ["credentialed termsUrl", { ...VALID_LEGAL, termsUrl: "https://user:pass@provider.example/terms" }, /credentials/],
    ["missing privacyUrl", { ...VALID_LEGAL, privacyUrl: undefined }, /privacyUrl/],
    ["empty privacyUrl", { ...VALID_LEGAL, privacyUrl: "  " }, /privacyUrl/],
    ["HTTP privacyUrl", { ...VALID_LEGAL, privacyUrl: "http://provider.example/privacy" }, /HTTPS/],
    ["malformed privacyUrl", { ...VALID_LEGAL, privacyUrl: "not a URL" }, /valid URL/],
    ["credentialed privacyUrl", { ...VALID_LEGAL, privacyUrl: "https://user@provider.example/privacy" }, /credentials/],
  ])("rejects %s", (_name, registration, pattern) => {
    expect(() => parseProviderLegalMetadata(registration)).toThrow(pattern);
  });

  it("requires both marketplace HTTPS URL environment variables", () => {
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MARKETPLACE_TERMS_URL: undefined }),
    ).toThrow(/MARKETPLACE_TERMS_URL env var is required/);
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MARKETPLACE_PRIVACY_URL: undefined }),
    ).toThrow(/MARKETPLACE_PRIVACY_URL env var is required/);
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MARKETPLACE_TERMS_URL: "http://daski.io/terms" }),
    ).toThrow(/HTTPS/);
    expect(() =>
      loadConfig({ ...VALID_CONFIG_ENV, MARKETPLACE_PRIVACY_URL: "  " }),
    ).toThrow(/non-empty/);
    expect(() =>
      loadConfig({
        ...VALID_CONFIG_ENV,
        MARKETPLACE_PRIVACY_URL: "not a URL",
      }),
    ).toThrow(/valid URL/);
    expect(() =>
      loadConfig({
        ...VALID_CONFIG_ENV,
        MARKETPLACE_PRIVACY_URL: "https://user@daski.io/privacy",
      }),
    ).toThrow(/credentials/);

    const config = loadConfig({
      ...VALID_CONFIG_ENV,
      MARKETPLACE_TERMS_URL: " https://daski.io/terms-of-use#agents ",
    });
    expect(config.marketplaceTermsUrl).toBe(
      "https://daski.io/terms-of-use#agents",
    );
  });

  it("checks provider legal links once without sending authentication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname === "/provider.json") {
        return new Response(JSON.stringify(VALID_LEGAL), {
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/terms") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://docs.example/terms-current#contract" },
        });
      }
      return new Response("ok");
    };

    await expect(
      validateProviderLegalReachability(
        "https://registry.example/provider.json",
        fetchFn,
      ),
    ).resolves.toEqual(VALID_LEGAL);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/provider.json",
      "/terms",
      "/terms-current",
      "/privacy",
    ]);
    expect(calls.slice(1).every((call) => call.init?.method === "GET")).toBe(
      true,
    );
    for (const call of calls) {
      expect(new Headers(call.init?.headers).has("authorization")).toBe(false);
    }
  });

  it("fails onboarding when either legal document is unreachable", async () => {
    const fetchFn = async (url: string) => {
      if (url.endsWith("provider.json")) {
        return new Response(JSON.stringify(VALID_LEGAL));
      }
      return new Response("not available", { status: 401 });
    };
    await expect(
      validateProviderLegalReachability(
        "https://registry.example/provider.json",
        fetchFn,
      ),
    ).rejects.toThrow(/termsUrl returned HTTP 401/);
  });

  it("bounds the initial registration-document fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("registration fetch aborted", "AbortError"));
          });
        });
      const validation = validateProviderLegalReachability(
        "https://registry.example/provider.json",
        fetchFn,
      );
      const rejection = expect(validation).rejects.toThrow(/aborted/);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
