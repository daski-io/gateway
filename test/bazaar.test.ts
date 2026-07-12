import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startTestGateway,
  type TestGateway,
} from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

// ── External-facilitator (Bazaar) rail ────────────────────────────────────
//
// These tests exercise the standard-x402 resource route end to end with a
// stubbed CDP facilitator: 402 shape (incl. the Bazaar discovery
// extension), the paid retry (verify → settle → attribution), idempotent
// replays, and every failure leg's recoverability story.

const DIRECT_ADAPTER_ADDRESS =
  "0x000000000000000000000000000000000000a007" as Hex;
const EXTERNAL_SETTLE_TX =
  "0xeeee00000000000000000000000000000000000000000000000000000000ee01" as Hex;
const ATTRIBUTION_TX =
  "0xaaaa00000000000000000000000000000000000000000000000000000000aa01" as Hex;

const PRICE = 5_000_000n; // register-domain fixed baseAmount
const BUYER_AGENT_ID = 7n;

interface FakeFacilitator {
  fetchFn: typeof fetch;
  calls: Array<{ path: "/verify" | "/settle"; body: any }>;
  setVerify(response: unknown, status?: number): void;
  setSettle(response: unknown, status?: number): void;
  reset(): void;
}

function makeFakeFacilitator(): FakeFacilitator {
  const calls: Array<{ path: "/verify" | "/settle"; body: any }> = [];
  let verifyResponse: unknown = { isValid: true, payer: null };
  let verifyStatus = 200;
  let settleResponse: unknown = {
    success: true,
    transaction: EXTERNAL_SETTLE_TX,
    network: "base-sepolia",
    payer: null,
  };
  let settleStatus = 200;

  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/verify")) {
      calls.push({ path: "/verify", body });
      return new Response(JSON.stringify(verifyResponse), {
        status: verifyStatus,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/settle")) {
      calls.push({ path: "/settle", body });
      return new Response(JSON.stringify(settleResponse), {
        status: settleStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected facilitator path", { status: 404 });
  }) as typeof fetch;

  return {
    fetchFn,
    calls,
    setVerify(response, status = 200) {
      verifyResponse = response;
      verifyStatus = status;
    },
    setSettle(response, status = 200) {
      settleResponse = response;
      settleStatus = status;
    },
    reset() {
      calls.length = 0;
      verifyResponse = { isValid: true, payer: null };
      verifyStatus = 200;
      settleResponse = {
        success: true,
        transaction: EXTERNAL_SETTLE_TX,
        network: "base-sepolia",
        payer: null,
      };
      settleStatus = 200;
    },
  };
}

describe("bazaar rail (/x402/services)", () => {
  let gw: TestGateway;
  let facilitator: FakeFacilitator;
  let nonceCounter = 1;

  function freshNonce(): Hex {
    const hex = (nonceCounter++).toString(16).padStart(64, "0");
    return `0x${hex}` as Hex;
  }

  function resourceUrl(tokenId: bigint, skillId: string): string {
    return `${gw.baseUrl}/x402/services/${tokenId.toString()}/${skillId}`;
  }

  async function fetch402(tokenId: bigint, skillId: string) {
    const res = await fetch(resourceUrl(tokenId, skillId));
    return { status: res.status, json: (await res.json()) as any };
  }

  async function fetchPost402(
    tokenId: bigint,
    skillId: string,
    serviceArgs: Record<string, unknown> = {},
  ) {
    const res = await fetch(resourceUrl(tokenId, skillId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceArgs }),
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  /** Sign + wrap a payment payload the way a standard x402 client would. */
  async function makePaymentHeader(
    value: bigint,
    nonce: Hex,
    opts: { version?: 1 | 2; accepted?: Record<string, unknown> } = {},
  ): Promise<string> {
    const version = opts.version ?? 2;
    const { signature, authorization } = await gw.signAuthorization(
      value,
      nonce,
    );
    const payload =
      version === 2
        ? {
            x402Version: 2,
            accepted:
              opts.accepted ?? {
                scheme: "exact",
                network: `eip155:${gw.config.chainId}`,
                amount: value.toString(),
                asset: gw.config.usdcAddress,
                payTo: gw.config.paymentRouterAddress,
                maxTimeoutSeconds: gw.config.challengeTtlSeconds,
                extra: { name: "USDC", version: "2" },
              },
            payload: { signature, authorization },
          }
        : {
            x402Version: 1,
            scheme: "exact",
            network: gw.config.network,
            payload: { signature, authorization },
          };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  async function payWithHeader(
    tokenId: bigint,
    skillId: string,
    header: string,
    serviceArgs: Record<string, unknown> = {},
  ) {
    const res = await fetch(resourceUrl(tokenId, skillId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": header,
      },
      body: JSON.stringify({ serviceArgs }),
    });
    return {
      status: res.status,
      json: (await res.json()) as any,
      paymentResponse: res.headers.get("payment-response"),
      legacyPaymentResponse: res.headers.get("x-payment-response"),
    };
  }

  async function quoteAndMakePaymentHeader(
    value: bigint,
    nonce: Hex,
    serviceArgs: Record<string, unknown> = {},
  ) {
    const paymentRequired = await fetchPost402(
      1n,
      "register-domain",
      serviceArgs,
    );
    expect(paymentRequired.status).toBe(402);
    const accepted = paymentRequired.json.accepts[0] as Record<string, unknown>;
    const header = await makePaymentHeader(value, nonce, { accepted });
    return { header, paymentRequired };
  }

  beforeAll(async () => {
    facilitator = makeFakeFacilitator();
    gw = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          priceUsdcSmallest: "1000000",
          category: "domains",
          name: "TestRegistrar",
          skills: [
            {
              id: "register-domain",
              description: "Register a .com domain for one year",
              metadata: {
                baseAmount: PRICE.toString(),
                serviceSlug: "domain-registration",
                version: "1",
              },
            },
            {
              id: "transfer-domain",
              description: "Transfer a domain in",
              metadata: {
                baseAmount: PRICE.toString(),
                serviceSlug: "domain-registration",
                version: "1",
              },
            },
            {
              id: "set-dns-record",
              description: "Free ownership-gated DNS management",
              metadata: { paymentRequired: false },
            },
          ],
        },
        {
          // Live-priced provider: no fixed baseAmount anywhere ("0" is the
          // live-pricing floor marker, not a price).
          tokenId: 2n,
          priceUsdcSmallest: "0",
          category: "domains",
          name: "LiveQuoteRegistrar",
          skills: [{ id: "live-priced" }],
        },
      ],
      configOverrides: { directAdapterAddress: DIRECT_ADAPTER_ADDRESS },
      externalFacilitatorFetch: facilitator.fetchFn,
    });
    gw.mockChain.setAgentOfWallet(gw.buyerAddress, BUYER_AGENT_ID);
    // Quote-commitment era: the 402's amount is the provider's QUOTED
    // price (quote == charge), not the static card amount. Align the
    // mock quotes with the prices the tests sign for.
    gw.mockProvider.setQuoteOutcome("register-domain", {
      ok: true,
      amount: PRICE,
    });
    gw.mockProvider.setQuoteOutcome("transfer-domain", {
      ok: true,
      amount: PRICE,
    });
    gw.mockProvider.setQuoteOutcome("live-priced", {
      ok: true,
      amount: 777_000n,
    });
  });

  afterAll(async () => {
    await gw.close();
  });

  // ── 402 issuance ─────────────────────────────────────────────────────

  it("serves a spec-shaped x402 v2 402 with the Bazaar extension", async () => {
    const quotesBefore = gw.mockProvider.getIssuedQuotes().length;
    const { status, json } = await fetch402(1n, "register-domain");
    expect(status).toBe(402);
    expect(json.x402Version).toBe(2);
    expect(json.resource.url).toBe(resourceUrl(1n, "register-domain"));
    expect(json.resource.mimeType).toBe("application/json");
    expect(json.resource.description).toContain("TestRegistrar");

    expect(json.accepts).toHaveLength(1);
    const accepts = json.accepts[0];
    expect(accepts.scheme).toBe("exact");
    expect(accepts.network).toBe(`eip155:${gw.config.chainId}`);
    expect(accepts.amount).toBe(PRICE.toString());
    expect(accepts.asset).toBe(gw.config.usdcAddress);
    expect(accepts.payTo).toBe(gw.config.paymentRouterAddress);
    expect(accepts.extra).toEqual({ name: "USDC", version: "2" });
    // v2 uses `amount`; the v1 field must not leak in.
    expect(accepts.maxAmountRequired).toBeUndefined();
    expect(accepts.maxTimeoutSeconds).toBe(gw.config.challengeTtlSeconds);
    expect(gw.mockProvider.getIssuedQuotes()).toHaveLength(quotesBefore);

    const bazaar = json.extensions?.bazaar;
    expect(bazaar).toBeDefined();
    expect(bazaar.info.input.method).toBe("POST");
    expect(bazaar.schema.properties.input).toBeDefined();
    expect(bazaar.schema.properties.input.properties.serviceArgs).toBeDefined();
    expect(bazaar.schema.properties.output).toBeDefined();
  });

  it("POST 402 embeds the provider quote bound to exact serviceArgs", async () => {
    const serviceArgs = { domain: "bazaar-quote.example" };
    const { status, json } = await fetchPost402(
      1n,
      "register-domain",
      serviceArgs,
    );
    expect(status).toBe(402);
    const providerQuote = json.accepts[0].extra.daski.providerQuote;
    const issued = gw.mockProvider.getIssuedQuotes();
    const quote = issued[issued.length - 1]!;
    expect(providerQuote.quoteId).toBe(quote.quoteId);
    expect(providerQuote.serviceRef).toBe(quote.serviceRef);
    expect(providerQuote.requestHash).toBe(quote.requestHash);
    expect(providerQuote.providerSignature).toBe(quote.providerSignature);
    expect(quote.serviceArgs).toEqual(serviceArgs);
    expect(json.accepts[0].maxTimeoutSeconds).toBeGreaterThanOrEqual(15);
    expect(json.accepts[0].maxTimeoutSeconds).toBeLessThanOrEqual(120);
  });

  it("404s unknown/free skills and requires POST args for live pricing", async () => {
    expect((await fetch402(1n, "no-such-skill")).status).toBe(404);
    expect((await fetch402(1n, "set-dns-record")).status).toBe(404);
    const liveDiscovery = await fetch402(2n, "live-priced");
    expect(liveDiscovery.status).toBe(422);
    expect(liveDiscovery.json.error).toContain("POST");
    const liveQuote = await fetchPost402(2n, "live-priced");
    expect(liveQuote.status).toBe(402);
    expect(liveQuote.json.accepts[0].amount).toBe("777000");
    expect((await fetch402(99n, "register-domain")).status).toBe(404);
  });

  it("rejects paid GET retries and never sends them to the facilitator", async () => {
    facilitator.reset();
    const { header } = await quoteAndMakePaymentHeader(
      PRICE,
      freshNonce(),
      { domain: "get-retry.example" },
    );
    const response = await fetch(resourceUrl(1n, "register-domain"), {
      headers: { "payment-signature": header },
    });
    expect(response.status).toBe(405);
    expect((await response.json()) as any).toMatchObject({
      error: expect.stringContaining("POST"),
    });
    expect(facilitator.calls).toHaveLength(0);
  });

  it("rejects a provider quote with too little settlement runway", async () => {
    facilitator.reset();
    gw.mockProvider.setQuoteOutcome("register-domain", {
      ok: true,
      amount: PRICE,
      ttlMs: 5_000,
    });
    try {
      const response = await fetchPost402(1n, "register-domain", {
        domain: "expires-too-soon.example",
      });
      expect(response.status).toBe(409);
      expect(response.json.error).toContain("less than 15 seconds");
      expect(facilitator.calls).toHaveLength(0);
    } finally {
      gw.mockProvider.setQuoteOutcome("register-domain", {
        ok: true,
        amount: PRICE,
      });
    }
  });

  it("advertises the bazaar resource URLs in /.well-known/x402-services.json", async () => {
    const res = await fetch(`${gw.baseUrl}/.well-known/x402-services.json`);
    const json = (await res.json()) as any;
    const resources = json.services.map((s: any) => s.resource);
    expect(resources).toContain(
      `${gw.baseUrl}/x402/services/1/register-domain`,
    );
  });

  // ── Paid retry: happy path ───────────────────────────────────────────

  it("settles via the external facilitator and attributes the split", async () => {
    facilitator.reset();
    const nonce = freshNonce();
    const serviceArgs = { domain: "paid-bazaar.example" };
    const { header, paymentRequired } = await quoteAndMakePaymentHeader(
      PRICE,
      nonce,
      serviceArgs,
    );
    const quoted = paymentRequired.json.accepts[0].extra.daski.providerQuote;
    const quotesBeforePayment = gw.mockProvider.getIssuedQuotes().length;

    gw.mockChain.queueAttribution({
      kind: "success",
      txHash: ATTRIBUTION_TX,
      event: {
        paymentId: 41n,
        serviceRef: ("0x" + "00".repeat(32)) as Hex,
        serviceId: ("0x" + "00".repeat(32)) as Hex,
        buyerAgentId: BUYER_AGENT_ID,
        providerAgentId: 1n,
        token: gw.config.usdcAddress,
        totalAmount: PRICE,
        providerAmount: (PRICE * 95n) / 100n,
        commission: (PRICE * 5n) / 100n,
      },
    });

    const res = await payWithHeader(
      1n,
      "register-domain",
      header,
      serviceArgs,
    );
    expect(res.status).toBe(200);
    expect(gw.mockProvider.getIssuedQuotes()).toHaveLength(quotesBeforePayment);

    // Facilitator saw verify then settle, with the resource injected for
    // Bazaar indexing and v2-shaped requirements.
    expect(facilitator.calls.map((c) => c.path)).toEqual([
      "/verify",
      "/settle",
    ]);
    const settleBody = facilitator.calls[1]!.body;
    expect(settleBody.x402Version).toBe(2);
    expect(settleBody.paymentPayload.resource.url).toBe(
      resourceUrl(1n, "register-domain"),
    );
    expect(settleBody.paymentRequirements.amount).toBe(PRICE.toString());
    expect(settleBody.paymentRequirements.payTo).toBe(
      gw.config.paymentRouterAddress,
    );

    // Attribution went on-chain with the client's nonce + buyer wallet —
    // and under the PROVIDER QUOTE's serviceRef, adopted verbatim.
    expect(gw.mockChain.attributions).toHaveLength(1);
    const attr = gw.mockChain.attributions[0]!;
    expect(attr.providerAgentId).toBe(1n);
    expect(attr.amount).toBe(PRICE);
    expect(attr.from).toBe(gw.buyerAddress);
    expect(attr.authNonce).toBe(nonce);
    const issued = gw.mockProvider.getIssuedQuotes();
    const lastQuote = issued.find((quote) => quote.quoteId === quoted.quoteId)!;
    expect(attr.serviceRef).toBe(lastQuote.serviceRef);

    // Receipt + settlement headers.
    const receipt = res.json.receipt;
    expect(receipt.paymentId).toBe("41");
    expect(receipt.skillId).toBe("register-domain");
    expect(receipt.settlementTransaction).toBe(EXTERNAL_SETTLE_TX);
    expect(receipt.attributionTransaction).toBe(ATTRIBUTION_TX);
    expect(receipt.buyerTokenId).toBe(BUYER_AGENT_ID.toString());
    // Quote credentials for the task submit (direct-A2A buyers copy them
    // into metadata; daski_submit_task injects automatically).
    expect(receipt.quote.quoteId).toBe(lastQuote.quoteId);
    expect(receipt.quote.quoteSignature).toBe(lastQuote.providerSignature);
    expect(receipt.serviceArgs).toEqual(serviceArgs);
    expect(res.paymentResponse).toBeTruthy();
    expect(res.legacyPaymentResponse).toBe(res.paymentResponse);
    const settlement = JSON.parse(
      Buffer.from(res.paymentResponse!, "base64").toString("utf8"),
    );
    expect(settlement.success).toBe(true);
    expect(settlement.transaction).toBe(EXTERNAL_SETTLE_TX);

    // Challenge row: paid, external rail, both txes recorded, and bound
    // to the provider quote (serviceRef + credentials + expiry).
    const challenge = await gw.bundle.queries.getChallengeByWalletAndNonce(
      gw.buyerAddress,
      nonce,
    );
    expect(challenge).not.toBeNull();
    expect(challenge!.rail).toBe("external");
    expect(challenge!.status).toBe("paid");
    expect(challenge!.paymentId).toBe(41n);
    expect(challenge!.externalSettleTx).toBe(EXTERNAL_SETTLE_TX);
    expect(challenge!.transactionHash).toBe(ATTRIBUTION_TX);
    expect(challenge!.serviceRef).toBe(lastQuote.serviceRef);
    expect(challenge!.quoteId).toBe(lastQuote.quoteId);
    expect(challenge!.quoteSignature).toBe(lastQuote.providerSignature);
    expect(challenge!.quoteExpiresAt).not.toBeNull();
    // Challenge expiry is bounded by the quote's TTL.
    expect(challenge!.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.parse(lastQuote.expiresAt),
    );

    // Replay of the exact same payload: stored receipt, no new facilitator
    // or chain traffic — and no new provider quote minted.
    const callsBefore = facilitator.calls.length;
    const quotesBefore = gw.mockProvider.getIssuedQuotes().length;
    const replay = await payWithHeader(
      1n,
      "register-domain",
      header,
      serviceArgs,
    );
    expect(replay.status).toBe(200);
    expect(replay.json.receipt.paymentId).toBe("41");
    expect(replay.json.receipt.quote.quoteId).toBe(lastQuote.quoteId);
    expect(facilitator.calls.length).toBe(callsBefore);
    expect(gw.mockProvider.getIssuedQuotes().length).toBe(quotesBefore);
    expect(gw.mockChain.attributions).toHaveLength(1);
  });

  // ── Failure legs ─────────────────────────────────────────────────────

  it("rejects unregistered buyers before any funds move", async () => {
    facilitator.reset();
    const unregistered = await startTestGateway({
      providers: [
        {
          tokenId: 1n,
          priceUsdcSmallest: "1000000",
          category: "domains",
          name: "TestRegistrar",
          skills: [
            {
              id: "register-domain",
              metadata: { baseAmount: PRICE.toString() },
            },
          ],
        },
      ],
      configOverrides: { directAdapterAddress: DIRECT_ADAPTER_ADDRESS },
      externalFacilitatorFetch: facilitator.fetchFn,
    });
    try {
      // NOTE: no setAgentOfWallet — the buyer wallet resolves to agentId 0.
      unregistered.mockProvider.setQuoteOutcome("register-domain", {
        ok: true,
        amount: PRICE,
      });
      const { signature, authorization } =
        await unregistered.signAuthorization(PRICE, freshNonce());
      const header = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          payload: { signature, authorization },
        }),
      ).toString("base64");
      const res = await fetch(
        `${unregistered.baseUrl}/x402/services/1/register-domain`,
        { method: "POST", headers: { "payment-signature": header } },
      );
      const json = (await res.json()) as any;
      expect(res.status).toBe(403);
      expect(json.error).toBe("buyer_not_registered");
      expect(json.register.prep).toContain("/register-prep");
      // Nothing was forwarded — the authorization is still unspent.
      expect(facilitator.calls).toHaveLength(0);
    } finally {
      await unregistered.close();
    }
  });

  it("rejects serviceArgs drift between the quoted 402 and paid retry", async () => {
    facilitator.reset();
    const attributionsBefore = gw.mockChain.attributions.length;
    const quotedArgs = { domain: "quoted-input.example" };
    const { header } = await quoteAndMakePaymentHeader(
      PRICE,
      freshNonce(),
      quotedArgs,
    );
    const response = await payWithHeader(
      1n,
      "register-domain",
      header,
      { domain: "substituted-input.example" },
    );
    expect(response.status).toBe(402);
    expect(response.json.error).toContain(
      "payment header does not carry the valid quote",
    );
    expect(response.json.error).toContain("requestHash");
    expect(facilitator.calls).toHaveLength(0);
    expect(gw.mockChain.attributions).toHaveLength(attributionsBefore);
  });

  it("402s an amount mismatch against the quoted price", async () => {
    facilitator.reset();
    const { header } = await quoteAndMakePaymentHeader(
      PRICE - 1n,
      freshNonce(),
    );
    const res = await payWithHeader(1n, "register-domain", header);
    expect(res.status).toBe(402);
    expect(res.json.error).toContain("does not match the quoted amount");
    expect(res.json.accepts).toHaveLength(1); // retryable: requirements attached
    expect(res.json.accepts[0].amount).toBe(PRICE.toString());
    expect(facilitator.calls).toHaveLength(0);
  });

  it("402s when the external facilitator rejects verification — no state kept", async () => {
    facilitator.reset();
    facilitator.setVerify({ isValid: false, invalidReason: "insufficient_funds" });
    const nonce = freshNonce();
    const { header } = await quoteAndMakePaymentHeader(PRICE, nonce);
    const res = await payWithHeader(1n, "register-domain", header);
    expect(res.status).toBe(402);
    expect(res.json.error).toContain("insufficient_funds");
    expect(
      await gw.bundle.queries.getChallengeByWalletAndNonce(
        gw.buyerAddress,
        nonce,
      ),
    ).toBeNull();
  });

  it("402s a failed external settle but keeps the challenge retryable", async () => {
    facilitator.reset();
    facilitator.setSettle({ success: false, errorReason: "broadcast_failed" });
    const nonce = freshNonce();
    const { header } = await quoteAndMakePaymentHeader(PRICE, nonce);
    const res = await payWithHeader(1n, "register-domain", header);
    expect(res.status).toBe(402);
    expect(res.json.error).toContain("broadcast_failed");
    const challenge = await gw.bundle.queries.getChallengeByWalletAndNonce(
      gw.buyerAddress,
      nonce,
    );
    expect(challenge).not.toBeNull();
    expect(challenge!.status).toBe("pending");
    expect(challenge!.externalSettleTx).toBeNull();
    // The pending row already carries the quote binding for the retry.
    expect(challenge!.quoteId).not.toBeNull();
    expect(challenge!.quoteSignature).not.toBeNull();
  });

  it("recovers from a failed attribution without re-settling or re-quoting", async () => {
    facilitator.reset();
    const nonce = freshNonce();
    const serviceArgs = { domain: "attribution-retry.example" };
    const { header } = await quoteAndMakePaymentHeader(
      PRICE,
      nonce,
      serviceArgs,
    );
    const quotesBefore = gw.mockProvider.getIssuedQuotes().length;

    gw.mockChain.queueAttribution({
      kind: "revert",
      reason: "rpc exploded mid-simulate",
    });
    const first = await payWithHeader(
      1n,
      "register-domain",
      header,
      serviceArgs,
    );
    expect(first.status).toBe(502);
    expect(first.json.error).toBe("attribution_pending");
    expect(first.json.settlementTransaction).toBe(EXTERNAL_SETTLE_TX);
    expect(facilitator.calls.map((c) => c.path)).toEqual([
      "/verify",
      "/settle",
    ]);

    const pending = await gw.bundle.queries.getChallengeByWalletAndNonce(
      gw.buyerAddress,
      nonce,
    );
    expect(pending?.externalSettleTx).toBe(EXTERNAL_SETTLE_TX);
    await gw.bundle.pool.query(
      `UPDATE payment_challenges
         SET status = 'expired',
             expires_at = NOW() - INTERVAL '1 minute',
             quote_expires_at = NOW() - INTERVAL '1 minute'
       WHERE service_ref = $1`,
      [Buffer.from(pending!.serviceRef.slice(2), "hex")],
    );

    // Retry with the SAME payload: external settle is skipped (funds are
    // already on the router), attribution runs and completes the purchase.
    gw.mockChain.queueAttribution({
      kind: "success",
      txHash: ATTRIBUTION_TX,
      event: {
        paymentId: 42n,
        serviceRef: ("0x" + "00".repeat(32)) as Hex,
        serviceId: ("0x" + "00".repeat(32)) as Hex,
        buyerAgentId: BUYER_AGENT_ID,
        providerAgentId: 1n,
        token: gw.config.usdcAddress,
        totalAmount: PRICE,
        providerAmount: (PRICE * 95n) / 100n,
        commission: (PRICE * 5n) / 100n,
      },
    });
    const second = await payWithHeader(
      1n,
      "register-domain",
      header,
      serviceArgs,
    );
    expect(second.status).toBe(200);
    expect(second.json.receipt.paymentId).toBe("42");
    // No additional verify/settle — the retry resumed at attribution —
    // and no second provider quote was minted (the persisted row's
    // quote-derived serviceRef is authoritative).
    expect(facilitator.calls.map((c) => c.path)).toEqual([
      "/verify",
      "/settle",
    ]);
    expect(gw.mockProvider.getIssuedQuotes().length).toBe(quotesBefore);
  });

  it("409s when the same nonce is replayed against a different purchase", async () => {
    facilitator.reset();
    const nonce = freshNonce();
    const { header } = await quoteAndMakePaymentHeader(PRICE, nonce);
    facilitator.setSettle({ success: false, errorReason: "keep pending" });
    // Bind the nonce to register-domain (challenge stays pending).
    const first = await payWithHeader(1n, "register-domain", header);
    expect(first.status).toBe(402);

    // Same (wallet, nonce) against a DIFFERENT paid skill: the nonce is
    // already bound to register-domain, so the gateway must refuse rather
    // than open a second purchase against the same authorization.
    const res = await payWithHeader(1n, "transfer-domain", header);
    expect(res.status).toBe(409);
    expect(res.json.error).toContain("already bound");
  });

  it("handles v1-generation payloads and facilitator bodies", async () => {
    facilitator.reset();
    const nonce = freshNonce();
    const header = await makePaymentHeader(PRICE, nonce, { version: 1 });
    gw.mockChain.queueAttribution({
      kind: "success",
      txHash: ATTRIBUTION_TX,
      event: {
        paymentId: 43n,
        serviceRef: ("0x" + "00".repeat(32)) as Hex,
        serviceId: ("0x" + "00".repeat(32)) as Hex,
        buyerAgentId: BUYER_AGENT_ID,
        providerAgentId: 1n,
        token: gw.config.usdcAddress,
        totalAmount: PRICE,
        providerAmount: (PRICE * 95n) / 100n,
        commission: (PRICE * 5n) / 100n,
      },
    });
    const res = await payWithHeader(1n, "register-domain", header);
    expect(res.status).toBe(200);
    expect(res.json.x402Version).toBe(1);
    // v1 facilitator requirements: maxAmountRequired + flat resource URL.
    const verifyBody = facilitator.calls[0]!.body;
    expect(verifyBody.x402Version).toBe(1);
    expect(verifyBody.paymentRequirements.maxAmountRequired).toBe(
      PRICE.toString(),
    );
    expect(verifyBody.paymentRequirements.resource).toBe(
      resourceUrl(1n, "register-domain"),
    );
    expect(verifyBody.paymentRequirements.network).toBe("base-sepolia");
  });
});
