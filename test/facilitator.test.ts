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
          erc8004TokenId: 102n,
          name: "Daski Domain Registration",
          priceUsdcSmallest: "15000000",
          category: "domain-registration",
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  async function openChallenge(): Promise<{
    serviceRef: Hex;
    paymentRequirements: PaymentRequirements;
  }> {
    const { status, json, serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
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
  });

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
  });

  // ── /settle atomic register-and-settle ─────────────────────────────────

  it("POST /settle with registration runs atomic register-and-settle when buyer has no agent", async () => {
    // Open a challenge with buyerTokenId="0" — i.e. wallet not yet registered.
    const { json: challengeJson, serviceRef } = await gateway.purchaseChallenge(
      2n,
      { buyerTokenId: "0" },
    );
    expect(serviceRef).toBeDefined();
    const paymentRequirements = challengeJson.accepts[0];

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
  });

  it("POST /settle returns 400 when challenge needs registration but body omits it", async () => {
    const { json: challengeJson } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "0",
    });
    const paymentRequirements = challengeJson.accepts[0];

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
          category: "x",
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
        { tokenId: 2n, name: "p", priceUsdcSmallest: "1000000", category: "x" },
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
        { tokenId: 2n, name: "p", priceUsdcSmallest: "1000000", category: "x" },
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
