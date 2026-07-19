import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex, PaymentPayload } from "../src/types.js";
import { computeRequestHash } from "../src/auth/envelope.js";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import { AGENT_AUTHORITY, PURCHASE_NOTICE } from "../src/legal/purchase.js";
import { makePaymentSettledEvent } from "./helpers/mockChain.js";

const TEST_TX = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const NONCE = "0xaaaa000000000000000000000000000000000000000000000000000000000001" as Hex;

describe("payment", () => {
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
        },
      ],
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  // ── Challenge phase (402 + PaymentRequirements) ─────────────────────

  it("issues a 402 with a spec-shaped PaymentRequirements", async () => {
    const { status, json, serviceRef, maxAmountRequired, payTo } = await gateway.purchaseChallenge(
      2n,
      { buyerTokenId: "5" },
    );
    expect(status).toBe(402);
    expect(json.x402Version).toBe(1);
    expect(Object.keys(json)).toEqual([
      "x402Version",
      "legal",
      "agentAuthority",
      "purchaseNotice",
      "accepts",
    ]);
    expect(Array.isArray(json.accepts)).toBe(true);
    expect(json.accepts).toHaveLength(1);

    const req = json.accepts[0];
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("base-sepolia");
    expect(req.maxAmountRequired).toBe("15000000");
    expect(req.description).toBe(
      "Daski Domain Registration — Daski Domain Registration description " +
        "Selected skill (default-service): default-service skill",
    );
    expect(req.payTo).toBe(gateway.config.paymentRouterAddress);
    expect(req.asset).toBe(gateway.config.usdcAddress);
    expect(req.extra.name).toBe("USDC");
    expect(req.extra.version).toBe("2");
    expect(req.extra.daski.providerTokenId).toBe("2");
    expect(req.extra.daski.buyerTokenId).toBe("5");
    expect(/^0x[0-9a-f]{64}$/.test(req.extra.daski.serviceRef)).toBe(true);

    const legal = {
      marketplaceTermsUrl: gateway.config.marketplaceTermsUrl,
      marketplacePrivacyUrl: gateway.config.marketplacePrivacyUrl,
      providerLegalName: "Example Provider, LLC",
      providerTermsUrl: "https://provider.example/terms",
      providerPrivacyUrl: "https://provider.example/privacy",
    };
    expect(json.legal).toEqual(legal);
    expect(json.agentAuthority).toEqual(AGENT_AUTHORITY);
    expect(json.purchaseNotice).toBe(PURCHASE_NOTICE);
    expect(req.extra.daski.legal).toEqual(legal);
    expect(req.extra.daski.agentAuthority).toEqual(AGENT_AUTHORITY);
    expect(req.extra.daski.purchaseNotice).toBe(PURCHASE_NOTICE);
    expect(String(req.extra.daski.eip712TypedData.message.value)).toBe(req.maxAmountRequired);

    // Informational rail advertisement — x402 always present, others only
    // if a configured adapter address exists. The test harness does not
    // configure permit/approval adapters, so exactly one rail is exposed.
    expect(Array.isArray(req.extra.daski.rails)).toBe(true);
    expect(req.extra.daski.rails).toHaveLength(1);
    expect(req.extra.daski.rails[0]).toEqual({
      name: "x402",
      kind: "eip3009",
      adapter: gateway.config.x402AdapterAddress,
    });
    expect(req.extra.daski.acceptedTokens).toEqual([gateway.config.usdcAddress]);

    // Exported convenience fields from the helper
    expect(serviceRef).toBe(req.extra.daski.serviceRef);
    expect(maxAmountRequired).toBe("15000000");
    expect(payTo).toBe(gateway.config.paymentRouterAddress);
  });

  it("adds permit and approval rails when those adapters are configured", async () => {
    const permitAdapter = "0x000000000000000000000000000000000000b001" as Hex;
    const approvalAdapter = "0x000000000000000000000000000000000000b002" as Hex;
    gateway.config.permitAdapterAddress = permitAdapter;
    gateway.config.approvalAdapterAddress = approvalAdapter;

    const { json } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const rails = json.accepts[0].extra.daski.rails;
    expect(rails.map((r: any) => r.name)).toEqual(["x402", "permit", "approval"]);
    expect(rails[1]).toEqual({
      name: "permit",
      kind: "eip2612",
      adapter: permitAdapter,
    });
    expect(rails[2]).toEqual({
      name: "approval",
      kind: "erc20-approve",
      adapter: approvalAdapter,
    });
  });

  it("returns 400 when buyerTokenId is missing", async () => {
    const { status, json } = await gateway.purchaseChallenge(2n, {});
    expect(status).toBe(400);
    expect(json.error).toMatch(/buyerTokenId/);
  });

  it("rejects a buyer token not controlled by the requesting wallet", async () => {
    gateway.mockChain.setAgentOwner(
      5n,
      "0x00000000000000000000000000000000000000ff" as Hex,
    );
    const res = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buyerTokenId: "5",
        walletAddress: gateway.buyerAddress,
        skillId: "default-service",
        serviceSlug: "domain-management",
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toContain(
      "does not control buyerTokenId",
    );
  });

  it("does not select a service by skill id when serviceSlug mismatches", async () => {
    const { status, json } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
      serviceSlug: "some-other-service",
    });
    expect(status).toBe(404);
    expect(json.error).toContain("does not list skill");
  });

  it("returns 404 when provider is not whitelisted", async () => {
    const { status, json } = await gateway.purchaseChallenge(999n, {
      buyerTokenId: "5",
      serviceSlug: "domain-management",
    });
    expect(status).toBe(404);
    expect(json.error).toMatch(/not whitelisted/);
  });

  it("returns 422 when pricing is missing", async () => {
    gateway.registerProvider({
      tokenId: 9n,
      name: "No extension",
      priceUsdcSmallest: "0",
      categoryFamily: "other",
      serviceType: "other",
    });
    const cardPath = "/agent-cards/9.json";
    const card = (await (
      await fetch(`${gateway.mockProvider.baseUrl}${cardPath}`)
    ).json()) as Record<string, unknown>;
    const extensions = card.extensions as Record<string, unknown>;
    const marketplace = extensions[DASKI_A2A_EXTENSION_URI] as Record<string, unknown>;
    const { pricing: _pricing, ...withoutPricing } = marketplace;
    gateway.mockProvider.setAgentCard(cardPath, {
      ...card,
      extensions: {
        ...extensions,
        [DASKI_A2A_EXTENSION_URI]: withoutPricing,
      },
    });
    await gateway.refresh();
    const { status, json } = await gateway.purchaseChallenge(9n, {
      buyerTokenId: "5",
    });
    expect(status).toBe(422);
    expect(json.error).toMatch(/pricing/i);
  });

  // ── Canonical facilitator settlement phase ──────────────────────────

  async function signAndBuildPayload(amount: bigint, nonce: Hex = NONCE): Promise<PaymentPayload> {
    const { signature, authorization } = await gateway.signAuthorization(amount, nonce);
    return {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };
  }

  it("verifies a valid EIP-3009 payment end-to-end", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    expect(serviceRef).toBeDefined();

    gateway.queueSettlementSuccess({
      txHash: TEST_TX,
      paymentId: 7n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });

    const payload = await signAndBuildPayload(15_000_000n);
    const { status, json } = await gateway.purchaseSettle(2n, payload);

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.transaction).toBe(TEST_TX);
    expect(json.network).toBe("base-sepolia");
    expect(json.payer).toBe(gateway.buyerAddress);
    expect(json.paymentId).toBe("7");
    expect(json.amount).toBe("15000000");
  });

  it("rejects wrong scheme", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await signAndBuildPayload(15_000_000n);
    (payload as any).scheme = "upto";

    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(400);
    expect(json.errorReason).toBe("invalid_scheme");
  });

  it("rejects wrong network", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await signAndBuildPayload(15_000_000n);
    (payload as any).network = "base";

    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(400);
    expect(json.errorReason).toBe("invalid_network");
  });

  it("rejects insufficient authorization value", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await signAndBuildPayload(1_000_000n);

    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(402);
    expect(json.errorReason).toBe("invalid_exact_evm_payload_authorization_value");
  });

  it("rejects mismatched recipient", async () => {
    await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const { signature, authorization } = await gateway.signAuthorization(15_000_000n, NONCE);
    // Tamper: change `to` to something that's not the router. Signature is
    // over the original `to`, so recovery will fail first — but we also want
    // to exercise the recipient check explicitly, so sign a fresh one.
    const tampered = {
      ...authorization,
      to: "0xdead000000000000000000000000000000000000" as Hex,
    };
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization: tampered },
    };

    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(402);
    // Either recipient_mismatch or bad_signature (since the signature was over
    // the original `to`). Both are acceptable failure modes.
    expect([
      "invalid_exact_evm_payload_recipient_mismatch",
      "invalid_exact_evm_payload_signature",
    ]).toContain(json.errorReason);
  });

  it("rejects expired authorization", async () => {
    await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const { signature, authorization } = await gateway.signAuthorization(15_000_000n, NONCE, {
      validBefore: BigInt(Math.floor(Date.now() / 1000) - 10),
    });
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };
    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(402);
    expect(json.errorReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });

  it("rejects a tampered signature", async () => {
    await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const { authorization } = await gateway.signAuthorization(15_000_000n, NONCE);
    // Well-formed 65-byte sig that doesn't correspond to the buyer.
    const bad = ("0x" + "11".repeat(65)) as Hex;
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature: bad, authorization },
    };

    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(402);
    expect(json.errorReason).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects a nonce already used on-chain", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    gateway.mockChain.setAuthorizationUsed(gateway.buyerAddress, NONCE, true);
    const payload = await signAndBuildPayload(15_000_000n);
    const { status, json } = await gateway.purchaseSettle(2n, payload);
    expect(status).toBe(402);
    expect(json.errorReason).toMatch(/authorization|payload/);
  });

  it("returns CHALLENGE_NOT_FOUND when serviceRef is unknown", async () => {
    const bogusRef = "0xdead000000000000000000000000000000000000000000000000000000000000" as Hex;
    const payload = await signAndBuildPayload(15_000_000n);
    const { status, json } = await gateway.purchaseSettle(2n, payload, bogusRef);
    expect(status).toBe(404);
    expect(json.errorReason).toMatch(/no challenge/);
  });

  it("rejects expired challenges", async () => {
    const expiredRef = "0xfeed000000000000000000000000000000000000000000000000000000000001" as Hex;
    await gateway.bundle.queries.insertChallenge({
      serviceRef: expiredRef,
      providerTokenId: 2n,
      buyerTokenId: 5n,
      amount: 15_000_000n,
      skillId: null,
      serviceSlug: "test-service",
      serviceVersion: "1",
      serviceId: ("0x" + "00".repeat(32)) as Hex,
      providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
      walletAddress: gateway.buyerAddress,
      expiresAt: new Date(Date.now() - 60_000),
      quoteId: "expired-test-quote",
      quoteSignature: "0x01" as Hex,
      quoteExpiresAt: new Date(Date.now() - 60_000),
      quoteRequestHash: computeRequestHash({}),
    });
    const payload = await signAndBuildPayload(15_000_000n);
    const { status, json } = await gateway.purchaseSettle(2n, payload, expiredRef);
    expect(status).toBe(410);
    expect(json.errorReason).toBe("authorization_expired");
  });

  it("is idempotent: a second settle with the same challenge returns the stored result", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });

    gateway.queueSettlementSuccess({
      txHash: TEST_TX,
      paymentId: 7n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });

    const payload = await signAndBuildPayload(15_000_000n);
    const first = await gateway.purchaseSettle(2n, payload);
    const second = await gateway.purchaseSettle(2n, payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.transaction).toBe(first.json.transaction);
    expect(second.json.paymentId).toBe(first.json.paymentId);
    // Only one on-chain submit happened (the mock would throw on a second).
    expect(gateway.mockChain.settlements.length).toBe(1);

    const forged: PaymentPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        signature: ("0x" + "00".repeat(65)) as Hex,
        authorization: {
          ...payload.payload.authorization,
          from: "0x00000000000000000000000000000000000000ff",
        },
      },
    };
    const rejected = await gateway.purchaseSettle(2n, forged);
    expect(rejected.status).toBe(402);
    expect(rejected.json.message).toMatch(/signature|wallet/i);
  });

  it("serializes concurrent settlement retries before broadcasting", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    gateway.queueSettlementSuccess({
      txHash: TEST_TX,
      paymentId: 8n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });
    const payload = await signAndBuildPayload(15_000_000n);
    const [first, second] = await Promise.all([
      gateway.purchaseSettle(2n, payload),
      gateway.purchaseSettle(2n, payload),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(gateway.mockChain.settlements).toHaveLength(1);
    expect(second.json.transaction).toBe(first.json.transaction);
  });

  it("recovers a settlement whose transaction was broadcast before receipt polling failed", async () => {
    const { serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    gateway.mockChain.queueSettlement({
      kind: "broadcast-error",
      txHash: TEST_TX,
      reason: "receipt RPC timed out",
      event: makePaymentSettledEvent({
        paymentId: 9n,
        serviceRef: serviceRef!,
        buyerAgentId: 5n,
        providerAgentId: 2n,
        totalAmount: 15_000_000n,
        token: gateway.config.usdcAddress,
      }),
    });
    const payload = await signAndBuildPayload(15_000_000n);

    const first = await gateway.purchaseSettle(2n, payload);
    expect(first.status).toBe(503);
    expect(first.json.errorReason).toBe("settlement_confirmation_pending");
    expect(
      (await gateway.bundle.queries.getChallengeByRef(serviceRef!))
        ?.transactionHash,
    ).toBe(TEST_TX);

    const retry = await gateway.purchaseSettle(2n, payload);
    expect(retry.status).toBe(200);
    expect(retry.json.transaction).toBe(TEST_TX);
    expect(retry.json.paymentId).toBe("9");
    expect(gateway.mockChain.settlements).toHaveLength(1);
  });

  it("expires stale challenges via the background job helper", async () => {
    const ref = "0xfeed000000000000000000000000000000000000000000000000000000000002" as Hex;
    await gateway.bundle.queries.insertChallenge({
      serviceRef: ref,
      providerTokenId: 2n,
      buyerTokenId: 5n,
      amount: 15_000_000n,
      skillId: null,
      serviceSlug: "test-service",
      serviceVersion: "1",
      serviceId: ("0x" + "00".repeat(32)) as Hex,
      providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
      walletAddress: gateway.buyerAddress,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expiredCount = await gateway.bundle.queries.expireStaleChallenges();
    expect(expiredCount).toBeGreaterThan(0);
    const stored = await gateway.bundle.queries.getChallengeByRef(ref);
    expect(stored?.status).toBe("expired");
  });

  it("deletes expired challenges after the retention window", async () => {
    const ref = "0xfeed000000000000000000000000000000000000000000000000000000000004" as Hex;
    await gateway.bundle.queries.insertChallenge({
      serviceRef: ref,
      providerTokenId: 2n,
      buyerTokenId: 5n,
      amount: 15_000_000n,
      skillId: null,
      serviceSlug: "test-service",
      serviceVersion: "1",
      serviceId: ("0x" + "00".repeat(32)) as Hex,
      providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
      walletAddress: gateway.buyerAddress,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await gateway.bundle.queries.expireStaleChallenges();

    expect(await gateway.bundle.queries.deleteExpiredChallenges(1, 10)).toBe(1);
    expect(await gateway.bundle.queries.getChallengeByRef(ref)).toBeNull();
  });

  it("does not expire a challenge after an external facilitator settled it", async () => {
    const ref = "0xfeed000000000000000000000000000000000000000000000000000000000003" as Hex;
    const settleTx = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hex;
    await gateway.bundle.queries.insertChallenge({
      serviceRef: ref,
      providerTokenId: 2n,
      buyerTokenId: 5n,
      amount: 15_000_000n,
      skillId: "default-service",
      serviceSlug: "test-service",
      serviceVersion: "1",
      serviceId: ("0x" + "00".repeat(32)) as Hex,
      providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
      walletAddress: gateway.buyerAddress,
      expiresAt: new Date(Date.now() - 60_000),
      rail: "external",
      authNonce: ("0x" + "33".repeat(32)) as Hex,
    });

    expect(await gateway.bundle.queries.recordChallengeExternallySettled(ref, settleTx)).toBe(true);
    expect(await gateway.bundle.queries.expireStaleChallenges()).toBe(0);

    const stored = await gateway.bundle.queries.getChallengeByRef(ref);
    expect(stored?.status).toBe("pending");
    expect(stored?.externalSettleTx).toBe(settleTx);
  });

  it("recovers an external-settlement expiry race through attribution", async () => {
    const ref = "0xfeed000000000000000000000000000000000000000000000000000000000004" as Hex;
    const settleTx = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex;
    const attributionTx =
      "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex;
    await gateway.bundle.queries.insertChallenge({
      serviceRef: ref,
      providerTokenId: 2n,
      buyerTokenId: 5n,
      amount: 15_000_000n,
      skillId: "default-service",
      serviceSlug: "test-service",
      serviceVersion: "1",
      serviceId: ("0x" + "00".repeat(32)) as Hex,
      providerA2AUrl: `${gateway.mockProvider.baseUrl}/a2a`,
      walletAddress: gateway.buyerAddress,
      expiresAt: new Date(Date.now() - 60_000),
      rail: "external",
      authNonce: ("0x" + "44".repeat(32)) as Hex,
    });

    expect(await gateway.bundle.queries.expireStaleChallenges()).toBe(1);
    expect(await gateway.bundle.queries.recordChallengeExternallySettled(ref, settleTx)).toBe(true);
    expect((await gateway.bundle.queries.getChallengeByRef(ref))?.status).toBe("pending");

    // Model an already-deployed sweeper (or a tight concurrent update)
    // that left the externally-settled row expired. Attribution must still
    // be able to finish because the buyer's funds have already moved.
    await gateway.bundle.pool.query(
      `UPDATE payment_challenges SET status = 'expired' WHERE service_ref = $1`,
      [Buffer.from(ref.slice(2), "hex")],
    );
    expect(await gateway.bundle.queries.recordChallengePaid(ref, 91n, attributionTx)).toBe(true);

    const stored = await gateway.bundle.queries.getChallengeByRef(ref);
    expect(stored?.status).toBe("paid");
    expect(stored?.paymentId).toBe(91n);
    expect(stored?.transactionHash).toBe(attributionTx);
  });

  it("/supported advertises the exact scheme on base-sepolia", async () => {
    const res = await fetch(`${gateway.baseUrl}/supported`);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    // The current x402 kind entry carries the CAIP-2 chain identifier.
    expect(body.kinds).toEqual([
      { scheme: "exact", network: "base-sepolia", chainId: "eip155:84532" },
    ]);
    expect(body).not.toHaveProperty("chainIdCaip2");
  });

  // Three-layer identity regression: when the Agent Card declares
  // `serviceSlug` in the skill's daski metadata, the gateway resolves
  // it instead of using skillId-as-slug. Two different skills sharing
  // the same serviceSlug must produce the same serviceId.
  it("resolves serviceSlug from skill metadata; two skills rolling up to one service share serviceId", async () => {
    gateway.registerProvider({
      tokenId: 42n,
      name: "Three-layer test provider",
      priceUsdcSmallest: "15000000",
      categoryFamily: "domains-web",
      serviceType: "domain-management",
      skills: [
        {
          id: "register-domain",
          metadata: {
            paymentRequired: true,
            serviceSlug: "domain-registration",
            baseAmount: "15000000",
          },
        },
        {
          id: "renew-domain",
          metadata: {
            paymentRequired: true,
            serviceSlug: "domain-registration",
            baseAmount: "15000000",
          },
        },
      ],
    });
    await gateway.refresh();

    const a = await gateway.purchaseChallenge(42n, {
      buyerTokenId: "5",
      skillId: "register-domain",
    });
    const b = await gateway.purchaseChallenge(42n, {
      buyerTokenId: "5",
      skillId: "renew-domain",
    });
    expect(a.status).toBe(402);
    expect(b.status).toBe(402);

    const aDaski = a.json.accepts[0].extra.daski;
    const bDaski = b.json.accepts[0].extra.daski;

    // Both challenges resolve to the same serviceSlug...
    expect(aDaski.serviceSlug).toBe("domain-registration");
    expect(bDaski.serviceSlug).toBe("domain-registration");
    // ...and therefore the same serviceId (since slug + version +
    // providerAgentId are identical).
    expect(aDaski.serviceId).toBe(bDaski.serviceId);
    // But the skillId is preserved on each challenge, so the provider
    // (or gateway) can still route each settlement to the right A2A
    // method off-chain.
    expect(aDaski.skillId).toBe("register-domain");
    expect(bDaski.skillId).toBe("renew-domain");
  });
});
