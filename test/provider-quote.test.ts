import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRequestHash } from "../src/auth/envelope.js";
import {
  fetchProviderQuote,
  validateProviderQuoteCommitment,
  type FetchProviderQuoteArgs,
  type ProviderQuoteCommitment,
} from "../src/payment/providerQuote.js";
import {
  MOCK_PROVIDER_CHAIN_ID,
  MOCK_PROVIDER_TOKEN_ADDRESS,
  startMockProvider,
  type MockProviderHandle,
} from "./helpers/mockProvider.js";

const SKILL_ID = "priced-skill";
const SERVICE_SLUG = "test-service";
const SERVICE_VERSION = "1";
const AMOUNT = "7000000";
const SERVICE_ARGS = {
  z: { second: 2, first: 1 },
  a: "canonical",
};

describe("provider quote validation", () => {
  let provider: MockProviderHandle;

  beforeEach(async () => {
    provider = await startMockProvider({ agentCards: {} });
    provider.setQuoteOutcome(SKILL_ID, {
      ok: true,
      amount: BigInt(AMOUNT),
      serviceSlug: SERVICE_SLUG,
      serviceVersion: SERVICE_VERSION,
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  function fetchArgs(): FetchProviderQuoteArgs {
    return {
      providerA2AUrl: `${provider.baseUrl}/a2a/${SERVICE_SLUG}`,
      skillId: SKILL_ID,
      serviceArgs: SERVICE_ARGS,
      expectedSignerAddress: provider.walletAddress,
      expectedChainId: MOCK_PROVIDER_CHAIN_ID,
      expectedTokenAddress: MOCK_PROVIDER_TOKEN_ADDRESS,
      expectedServiceSlug: SERVICE_SLUG,
      expectedServiceVersion: SERVICE_VERSION,
      fetchFn: fetch,
    };
  }

  async function validQuote(): Promise<ProviderQuoteCommitment> {
    const result = await fetchProviderQuote(fetchArgs());
    expect(result.ok).toBe(true);
    if (!result.ok || !result.quote) throw new Error("expected a signed quote");
    return result.quote;
  }

  it("accepts a real EIP-191 quote bound to canonical serviceArgs", async () => {
    const quote = await validQuote();

    expect(quote.requestHash).toBe(computeRequestHash(SERVICE_ARGS));
    expect(quote.signerAddress).toBe(provider.walletAddress);
    expect(quote.amount).toBe(AMOUNT);
    expect(quote.serviceSlug).toBe(SERVICE_SLUG);
  });

  it("rejects structural and signed-payload tampering", async () => {
    const quote = await validQuote();
    const zero32 = `0x${"00".repeat(32)}`;
    const mutations: Array<[string, (copy: Record<string, unknown>) => void]> = [
      ["missing quoteId", (copy) => delete copy.quoteId],
      ["empty serviceId", (copy) => { copy.serviceId = ""; }],
      ["requestHash", (copy) => { copy.requestHash = zero32; }],
      ["serviceRef", (copy) => { copy.serviceRef = zero32; }],
      ["amount", (copy) => { copy.amount = "7000001"; }],
      ["token", (copy) => { copy.token = "0x0000000000000000000000000000000000000001"; }],
      ["chainId", (copy) => { copy.chainId = 1; }],
      ["quoteVersion", (copy) => { copy.quoteVersion = "provider-quote-v2"; }],
      ["skillId", (copy) => { copy.skillId = "other-skill"; }],
      ["serviceSlug", (copy) => { copy.serviceSlug = "other-service"; }],
      ["serviceVersion", (copy) => { copy.serviceVersion = "2"; }],
      ["issuedAt", (copy) => { copy.issuedAt = "not-a-date"; }],
      ["expiresAt", (copy) => { copy.expiresAt = quote.issuedAt; }],
      ["signerAddress", (copy) => { copy.signerAddress = "0x0000000000000000000000000000000000000001"; }],
      ["signingKeyId", (copy) => { copy.signingKeyId = "provider-wallet-v1:wrong"; }],
      ["providerSignature", (copy) => { copy.providerSignature = `0x${"11".repeat(65)}`; }],
    ];

    for (const [name, mutate] of mutations) {
      const copy = structuredClone(quote) as unknown as Record<string, unknown>;
      mutate(copy);
      const result = await validateProviderQuoteCommitment(copy, {
        skillId: SKILL_ID,
        serviceArgs: SERVICE_ARGS,
        amount: AMOUNT,
        expectedSignerAddress: provider.walletAddress,
        expectedChainId: MOCK_PROVIDER_CHAIN_ID,
        expectedTokenAddress: MOCK_PROVIDER_TOKEN_ADDRESS,
        expectedServiceSlug: SERVICE_SLUG,
        expectedServiceVersion: SERVICE_VERSION,
      });
      expect(result.ok, name).toBe(false);
    }
  });

  it("rejects request, top-level amount, signer, and expiry mismatches", async () => {
    const quote = await validQuote();
    const base = {
      skillId: SKILL_ID,
      serviceArgs: SERVICE_ARGS,
      amount: AMOUNT,
      expectedSignerAddress: provider.walletAddress,
      expectedChainId: MOCK_PROVIDER_CHAIN_ID,
      expectedTokenAddress: MOCK_PROVIDER_TOKEN_ADDRESS,
      expectedServiceSlug: SERVICE_SLUG,
      expectedServiceVersion: SERVICE_VERSION,
    };

    const mismatches = [
      { ...base, serviceArgs: { a: "substituted" } },
      { ...base, amount: "7000001" },
      {
        ...base,
        expectedSignerAddress:
          "0x0000000000000000000000000000000000000001" as const,
      },
      { ...base, now: new Date(Date.parse(quote.expiresAt) + 1) },
    ];
    for (const expectations of mismatches) {
      const result = await validateProviderQuoteCommitment(quote, expectations);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a quote whose amount differs from the top-level response", async () => {
    const args = fetchArgs();
    args.fetchFn = async (url, init) => {
      const response = await fetch(url, init);
      const body = (await response.json()) as Record<string, unknown>;
      body.amount = "7000001";
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await fetchProviderQuote(args);
    expect(result).toMatchObject({ ok: false, code: "quote_malformed" });
    if (!result.ok) expect(result.message).toMatch(/amount/);
  });
});
