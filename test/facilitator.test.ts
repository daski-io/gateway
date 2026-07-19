import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex, PaymentPayload, PaymentRequirements } from "../src/types.js";

const TEST_TX =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;
const NONCE =
  "0xbbbb000000000000000000000000000000000000000000000000000000000001" as Hex;

describe("facilitator endpoints", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Daski Domain Registration",
          priceUsdcSmallest: "15000000",
          categoryFamily: "domains-web",
          serviceType: "domain-management",
          skills: [
            {
              id: "default-service",
              metadata: {
                paymentRequired: true,
                serviceSlug: "default-service",
                baseAmount: "15000000",
              },
            },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function openChallenge(buyerTokenId = "5"): Promise<{
    serviceRef: Hex;
    paymentRequirements: PaymentRequirements;
  }> {
    const quoteRes = await fetch(
      `${gateway.mockProvider.baseUrl}/quote/default-service`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "default-service", serviceArgs: {} }),
      },
    );
    expect(quoteRes.status).toBe(200);
    const quoteBody = (await quoteRes.json()) as { quote: unknown };
    const { status, json, serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId,
      serviceSlug: "default-service",
      serviceArgs: {},
      providerQuote: quoteBody.quote,
    });
    expect(status).toBe(402);
    expect(serviceRef).toBeDefined();
    return {
      serviceRef: serviceRef!,
      paymentRequirements: json.accepts[0] as PaymentRequirements,
    };
  }

  // ── /verify ────────────────────────────────────────────────────────────

  it("POST /verify returns isValid:true for a well-signed payload", async () => {
    const { paymentRequirements } = await openChallenge();

    const { signature, authorization } = await gateway.signAuthorization(
      15_000_000n,
      NONCE,
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };

    const res = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.isValid).toBe(true);
    expect(body.invalidReason).toBeNull();
    expect(body.payer.toLowerCase()).toBe(gateway.buyerAddress);
  });

  it("POST /verify returns isValid:false with a reason for bad signature", async () => {
    const { paymentRequirements } = await openChallenge();

    const bad: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature: ("0x" + "00".repeat(65)) as Hex,
        authorization: {
          from: gateway.buyerAddress,
          to: gateway.config.paymentRouterAddress,
          value: "15000000",
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 3600),
          nonce: NONCE,
        },
      },
    };

    const res = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: bad,
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toMatch(/signature/i);
  });

  it("POST /verify rejects bodies without a serviceRef", async () => {
    const res = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: {
          x402Version: 1,
          scheme: "exact",
          network: "base-sepolia",
          payload: {
            signature: ("0x" + "00".repeat(65)) as Hex,
            authorization: {
              from: gateway.buyerAddress,
              to: gateway.config.paymentRouterAddress,
              value: "1",
              validAfter: "0",
              validBefore: "0",
              nonce: NONCE,
            },
          },
        },
        paymentRequirements: { extra: { daski: {} } },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toMatch(/serviceRef/);
  });

  // ── /settle ────────────────────────────────────────────────────────────

  it("rejects malformed providerTokenId without destabilizing the server", async () => {
    const { paymentRequirements } = await openChallenge();
    paymentRequirements.extra.daski.providerTokenId = "not-a-number";
    const res = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: {},
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      success: false,
      errorReason: expect.stringMatching(/providerTokenId.*numeric/),
    });
    expect((await fetch(`${gateway.baseUrl}/health`)).status).toBe(200);
  });

  it("POST /settle submits on-chain and returns the flat Daski-extended body", async () => {
    const { serviceRef, paymentRequirements } = await openChallenge();

    const { signature, authorization } = await gateway.signAuthorization(
      15_000_000n,
      NONCE,
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };

    gateway.queueSettlementSuccess({
      txHash: TEST_TX,
      paymentId: 42n,
      serviceRef,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });

    const res = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // spec-base fields
    expect(body.success).toBe(true);
    expect(body.errorReason).toBeNull();
    expect(body.transaction).toBe(TEST_TX);
    expect(body.network).toBe("base-sepolia");
    expect(body.payer.toLowerCase()).toBe(gateway.buyerAddress);

    // Daski-extended fields — flat, not nested under `daski`
    expect(body.paymentId).toBe("42");
    expect(body.serviceRef).toBe(serviceRef);
    expect(body.providerTokenId).toBe("2");
    expect(body.buyerTokenId).toBe("5");
    expect(body.amount).toBe("15000000");
    expect(body.providerA2AUrl).toMatch(/^http/);
    const quote = paymentRequirements.extra.daski.quote;
    expect(quote).toBeDefined();
    expect(body.quoteId).toBe(quote!.quoteId);
    expect(body.quoteSignature).toBe(quote!.quoteSignature);
    const stored = await gateway.bundle.queries.getChallengeByRef(serviceRef);
    const issuedQuote = gateway.mockProvider.getIssuedQuotes().at(-1);
    expect(issuedQuote).toBeDefined();
    expect(stored?.quoteRequestHash).toBe(issuedQuote!.requestHash);

    // A retry is served from the paid challenge without another on-chain
    // submission and retains the credentials needed for task dispatch.
    const retry = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as any;
    expect(retryBody.transaction).toBe(TEST_TX);
    expect(retryBody.quoteId).toBe(body.quoteId);
    expect(retryBody.quoteSignature).toBe(body.quoteSignature);
    expect(gateway.mockChain.settlements).toHaveLength(1);
  });

  it.each([
    ["quote_id", "quoteId"],
    ["quote_signature", "quoteSignature"],
    ["quote_expires_at", "quoteExpiresAt"],
    ["quote_request_hash", "quoteRequestHash"],
  ] as const)(
    "POST /settle fails closed when the stored %s commitment is missing",
    async (column, field) => {
      const { serviceRef, paymentRequirements } = await openChallenge();
      await gateway.bundle.pool.query(
        `UPDATE payment_challenges SET ${column} = NULL WHERE service_ref = $1`,
        [Buffer.from(serviceRef.slice(2), "hex")],
      );
      const { signature, authorization } = await gateway.signAuthorization(
        15_000_000n,
        NONCE,
      );
      const res = await fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            x402Version: 1,
            scheme: "exact",
            network: "base-sepolia",
            payload: { signature, authorization },
          },
          paymentRequirements,
        }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.success).toBe(false);
      expect(body.errorReason).toBe("quote_commitment_missing");
      expect(body.invalidReason ?? body.errorReason).toBeTruthy();
      expect(JSON.stringify(body)).toContain(field);
      expect(gateway.mockChain.settlements).toHaveLength(0);
    },
  );

  it("POST /settle returns an error body on chain revert", async () => {
    const { serviceRef, paymentRequirements } = await openChallenge();

    const { signature, authorization } = await gateway.signAuthorization(
      15_000_000n,
      NONCE,
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };

    gateway.mockChain.queueSettlement({
      kind: "revert",
      reason: "out of gas",
    });

    const res = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.errorReason).toMatch(/unexpected_settle_error/);
    expect(body.paymentId).toBeNull();
    expect(body.serviceRef).toBe(serviceRef);
    expect(body.quoteId).toBe(paymentRequirements.extra.daski.quote?.quoteId);
    expect(body.quoteSignature).toBe(
      paymentRequirements.extra.daski.quote?.quoteSignature,
    );
  });

  // ── /settle atomic register-and-settle ─────────────────────────────────

  it("POST /settle with registration runs atomic register-and-settle when buyer has no agent", async () => {
    // Open a challenge with buyerTokenId="0" — i.e. wallet not yet registered.
    const { serviceRef, paymentRequirements } = await openChallenge("0");
    expect(serviceRef).toBeDefined();

    const { signature, authorization } = await gateway.signAuthorization(
      15_000_000n,
      ("0xabcd" + "00".repeat(30)) as Hex,
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };

    // Queue both: registration first, settle second. The mock's
    // settleWithRegistration consumes them in order.
    gateway.mockChain.queueRegistration({
      kind: "success",
      agentId: 77n,
      txHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex,
    });
    gateway.queueSettlementSuccess({
      txHash: TEST_TX,
      paymentId: 100n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 77n, // freshly minted
      totalAmount: 15_000_000n,
    });

    const res = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
        registration: {
          agentURI: "ipfs://buyer.json",
          deadline: String(Math.floor(Date.now() / 1000) + 600),
          signature: ("0x" + "11".repeat(65)) as Hex,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.success).toBe(true);
    expect(body.paymentId).toBe("100");
    expect(body.buyerTokenId).toBe("77"); // from the event, not from challenge
    expect(body.registered).toBe(true);

    // Ensure both mock paths were exercised.
    expect(gateway.mockChain.registrations).toHaveLength(1);
    expect(gateway.mockChain.settlements).toHaveLength(1);

    // Atomic path must mirror the same `buyer_identities` upsert that the
    // explicit /register endpoint does — pre-fix, the cache stayed empty
    // for any buyer whose first action was a purchase rather than a bare
    // registration. The test gateway's default agent-card fetcher returns
    // `{ name: "buyer-test" }`, so the resolved name lands here.
    const cached = await gateway.bundle.queries.getBuyerIdentity(77n);
    expect(cached).not.toBeNull();
    expect(cached?.resolvedName).toBe("buyer-test");
    expect(cached?.agentURI).toBe("ipfs://buyer.json");

    // Backfill check: the challenge row was opened with buyer_token_id=0
    // (atomic-register placeholder); after settle, the row must carry the
    // freshly-minted agentId from the PaymentSettled event. Without this,
    // /public/v1/activity would render `agent#0` and the buyer-name
    // resolver would have nothing to look up.
    const activityRes = await fetch(`${gateway.baseUrl}/public/v1/activity`);
    const activityBody = (await activityRes.json()) as any;
    const row = activityBody.activity.find(
      (r: any) => r.txHash.toLowerCase() === TEST_TX.toLowerCase(),
    );
    expect(row).toBeDefined();
    expect(row.buyerAgentId).toBe("77");
  });

  it("POST /settle returns 400 when challenge needs registration but body omits it", async () => {
    const { paymentRequirements } = await openChallenge("0");

    const { signature, authorization } = await gateway.signAuthorization(
      15_000_000n,
      ("0xfeed" + "00".repeat(30)) as Hex,
    );
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };

    const res = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.success).toBe(false);
    expect(body.errorReason).toBe("registration_required");
  });
});

describe("GET /identity/by-wallet", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "p",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns the agentId for a registered wallet", async () => {
    const wallet =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
    gateway.mockChain.setAgentOfWallet(wallet, 7n);
    const res = await fetch(`${gateway.baseUrl}/identity/by-wallet/${wallet}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.address).toBe(wallet);
    expect(body.agentId).toBe("7");
  });

  it("returns null agentId for an unregistered wallet", async () => {
    const wallet =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
    const res = await fetch(`${gateway.baseUrl}/identity/by-wallet/${wallet}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agentId).toBeNull();
  });

  it("rejects a malformed address", async () => {
    const res = await fetch(`${gateway.baseUrl}/identity/by-wallet/not-hex`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("BAD_ADDRESS");
  });
});

describe("GET /supported advertises facilitator endpoints", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "p",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("lists verify + settle endpoints and the canonical chain addresses", async () => {
    const res = await fetch(`${gateway.baseUrl}/supported`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.kinds).toEqual([
      { scheme: "exact", network: "base-sepolia", chainId: "eip155:84532" },
    ]);
    expect(body.endpoints.verify).toBe("/verify");
    expect(body.endpoints.settle).toBe("/settle");
    expect(body.identityRegistryAddress).toBe(
      gateway.config.identityRegistryAddress,
    );
    expect(body.eas.address).toBe(gateway.config.easAddress);
    expect(body.eas.confirmationSchemaUid).toBe(
      gateway.config.easConfirmationSchemaUid,
    );
  });
});

describe("GET /eas/nonce", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "p",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns the attester nonce from the chain", async () => {
    const wallet =
      "0xcccccccccccccccccccccccccccccccccccccccc" as Hex;
    gateway.mockChain.setEasAttesterNonce(wallet, 11n);
    const res = await fetch(`${gateway.baseUrl}/eas/nonce/${wallet}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.nonce).toBe("11");
  });
});
