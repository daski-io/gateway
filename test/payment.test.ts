import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASKI_X402_EXTENSION_URI,
  X402_VERSION,
} from "../src/config.js";
import type { Hex } from "../src/types.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { TEST_BUYER_KEY } from "./helpers/setup.js";

const TX =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

describe("x402 V2 HTTP payment resource", () => {
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

  it("issues canonical V2 requirements through PAYMENT-REQUIRED", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    expect(challenge.status).toBe(402);
    expect(challenge.json.error).toBe("payment_required");
    const required = challenge.paymentRequired!;
    expect(required.x402Version).toBe(X402_VERSION);
    expect(required.resource.url).toBe(`${gateway.baseUrl}/purchase/2`);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: "daski-exact",
      network: "eip155:84532",
      amount: "15000000",
      asset: gateway.config.usdcAddress,
      payTo: gateway.config.x402AdapterAddress,
      extra: {
        assetTransferMethod: "eip3009-receive",
        name: "USDC",
        version: "2",
        daskiProfile: "1",
        paymentRouter: gateway.config.paymentRouterAddress,
      },
    });
    expect(required.accepts[0]?.extra).not.toHaveProperty("daski");
    const extension = required.extensions?.[
      DASKI_X402_EXTENSION_URI
    ] as any;
    expect(extension.info).toMatchObject({
      profile: "1",
      x402Adapter: gateway.config.x402AdapterAddress,
      paymentRouter: gateway.config.paymentRouterAddress,
      providerAgentId: "2",
      buyerAgentId: "5",
      settlementMode: "settle-only",
    });
    expect(extension.info.serviceRef).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects REST self-purchases before challenge persistence", async () => {
    gateway.mockChain.setAgentOwner(2n, gateway.buyerAddress);
    const sameAgent = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "2",
    });
    expect(sameAgent.status).toBe(403);
    expect(sameAgent.json.error).toBe("self_purchase_not_allowed");

    gateway.mockChain.setAgentOwner(
      5n,
      gateway.mockProvider.walletAddress,
    );
    const sameWallet = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
      walletAddress: gateway.mockProvider.walletAddress,
    });
    expect(sameWallet.status).toBe(403);
    expect(sameWallet.json.error).toBe("self_purchase_not_allowed");

    const stored = await gateway.bundle.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM payment_challenges",
    );
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("keeps the encoded challenge below the 8 KiB header budget", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(challenge.requestBody),
    });
    const encoded = response.headers.get("payment-required")!;
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(8192);
  });

  it("settles a Daski receive payload on the same paid resource", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await gateway.createPaymentPayload(
      challenge.paymentRequired!,
    );
    const authorization = payload.payload.authorization as { nonce: Hex };
    expect(authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 42n,
      serviceRef: challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });

    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": encodePaymentSignatureHeader(payload),
      },
      body: JSON.stringify(challenge.requestBody),
    });
    expect(
      response.status,
      JSON.stringify(await response.clone().json()),
    ).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const settled = decodePaymentResponseHeader(
      response.headers.get("payment-response")!,
    );
    expect(settled).toMatchObject({
      success: true,
      transaction: TX,
      network: "eip155:84532",
      amount: "15000000",
    });
    expect(
      (settled.extensions?.[DASKI_X402_EXTENSION_URI] as any).paymentId,
    ).toBe("42");
  });

  it("rejects a standard-only exact client before payload creation", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const standardOnly = new x402Client().register(
      "eip155:84532",
      new ExactEvmScheme(privateKeyToAccount(TEST_BUYER_KEY)),
    );

    await expect(
      standardOnly.createPaymentPayload(challenge.paymentRequired!),
    ).rejects.toThrow(/No network\/scheme registered/);
    expect(gateway.mockChain.settlements).toHaveLength(0);
  });

  it("returns the stored settlement for an identical replay", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await gateway.createPaymentPayload(
      challenge.paymentRequired!,
    );
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 42n,
      serviceRef: challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });
    const request = () =>
      fetch(`${gateway.baseUrl}/purchase/2`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": encodePaymentSignatureHeader(payload),
        },
        body: JSON.stringify(challenge.requestBody),
      });
    const first = await request();
    expect(
      first.status,
      JSON.stringify(await first.clone().json()),
    ).toBe(200);
    expect((await request()).status).toBe(200);
  });

  it("rejects a changed paid-retry request fingerprint", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await gateway.createPaymentPayload(
      challenge.paymentRequired!,
    );
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": encodePaymentSignatureHeader(payload),
      },
      body: JSON.stringify({
        ...challenge.requestBody,
        serviceArgs: { changed: true },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("differs"),
    });
  });

  it("rejects the retired X-PAYMENT header", async () => {
    const response = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": "retired",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  it("requires registration before issuing a fresh-wallet challenge", async () => {
    const response = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "0",
    });
    expect(response.status).toBe(409);
    expect(response.json.error).toBe("registration_required");
    expect(response.json.registrationPrep.eip712TypedData.primaryType).toBe(
      "RegisterAgent",
    );
    expect(response.paymentRequired).toBeUndefined();
  });

  it("publishes V2-only facilitator capabilities and extension schema", async () => {
    const supported = await (await fetch(`${gateway.baseUrl}/supported`)).json() as any;
    expect(supported.kinds).toEqual([
      {
        x402Version: 2,
        scheme: "daski-exact",
        network: "eip155:84532",
        extra: { daskiProfile: "1" },
      },
    ]);
    expect(supported.extensions).toContain(DASKI_X402_EXTENSION_URI);
    expect(supported.signers["eip155:*"]).toHaveLength(1);

    const schema = await (
      await fetch(`${gateway.baseUrl}/.well-known/x402-daski-v2.schema.json`)
    ).json() as any;
    expect(schema.$id).toBe(
      `${gateway.baseUrl}/.well-known/x402-daski-v2.schema.json`,
    );
  });
});
