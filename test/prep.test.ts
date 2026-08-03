import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

const TEST_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

describe("x402 V2 payment preparation", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Domain Reg",
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

  it("returns signable Daski requirements while allowing client salts", async () => {
    const { json, status, serviceRef, paymentRequired } =
      await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
      serviceArgs: { request: "one" },
    });
    expect(status).toBe(402);
    expect(serviceRef).toBeDefined();
    expect(paymentRequired?.x402Version).toBe(2);
    expect(paymentRequired?.accepts[0]).toMatchObject({
      scheme: "daski-exact",
      network: "eip155:84532",
      amount: "15000000",
      asset: gateway.config.usdc.address,
      payTo: gateway.config.x402AdapterAddress,
    });
    const signing = paymentRequired?.extensions?.[
      "https://daski.xyz/x402/v2"
    ] as {
      signing?: {
        nonceSalt: Hex;
        eip712TypedData: { primaryType: string };
      };
    };
    expect(signing.signing).toMatchObject({
      nonceSalt: expect.stringMatching(/^0x[0-9a-fA-F]{64}$/),
      eip712TypedData: { primaryType: "ReceiveWithAuthorization" },
    });
    expect(json).not.toHaveProperty("accepts");

    const first = await gateway.createPaymentPayload(paymentRequired!);
    const second = await gateway.createPaymentPayload(paymentRequired!);
    const firstNonce = (first.payload as { authorization: { nonce: Hex } })
      .authorization.nonce;
    const secondNonce = (second.payload as { authorization: { nonce: Hex } })
      .authorization.nonce;
    const firstSalt = (first.payload as { nonceSalt: Hex }).nonceSalt;
    const secondSalt = (second.payload as { nonceSalt: Hex }).nonceSalt;
    expect(firstNonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(firstSalt).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(secondSalt).not.toBe(firstSalt);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it("a Daski receive client payload settles end-to-end", async () => {
    const { serviceRef, paymentRequired } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await gateway.createPaymentPayload(paymentRequired!);
    gateway.queueSettlementSuccess({
      txHash: ("0x" + "ab".repeat(32)) as Hex,
      paymentId: 7n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });
    const settled = await gateway.purchaseSettle(2n, payload);
    expect(settled.status).toBe(200);
    expect(settled.json.success).toBe(true);
  });

  it("rejects /purchase 402 phase when walletAddress is missing", async () => {
    const res = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Deliberately omit walletAddress; the helper would set a default
      // for us, so we hit the route directly here.
      body: JSON.stringify({ buyerTokenId: "5" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/walletAddress/);
  });
});

// ── /confirm-prep ─────────────────────────────────────────────────────────

describe("GET /confirm-prep/:paymentId", () => {
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
    // Prep reads the router record to fill the resolver-required recipient.
    for (const paymentId of [42n, 99n]) gateway.mockChain.setPaymentRecord(paymentId, {
      buyerAgentId: 7n,
      providerAgentId: 2n,
      serviceId: ("0x" + "cd".repeat(32)) as Hex,
      token: "0x000000000000000000000000000000000000a003" as Hex,
      amount: 1_000_000n,
      cachedBuyerWallet: "0x000000000000000000000000000000000000b001" as Hex,
      cachedProviderOwner: "0x000000000000000000000000000000000000c001" as Hex,
      cachedProviderWallet: "0x000000000000000000000000000000000000c002" as Hex,
      serviceRef: ("0x" + "ab".repeat(32)) as Hex,
      paidAt: BigInt(Math.floor(Date.now() / 1000)),
      reputationEligible: true,
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("returns EAS Attest typed-data using the on-chain attester nonce", async () => {
    const attester = ("0x" + "aa".repeat(20)) as Hex;
    gateway.mockChain.setEasAttesterNonce(attester, 17n);

    const url = `${gateway.baseUrl}/confirm-prep/42?confirmation=Confirmed&attester=${attester}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.paymentId).toBe("42");
    expect(body.confirmation).toBe("Confirmed");
    expect(body.attester).toBe(attester);
    expect(Number(body.deadline)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const td = body.eip712TypedData;
    expect(td.primaryType).toBe("Attest");
    expect(td.domain.name).toBe("EAS");
    expect(td.domain.version).toBe("1.2.0");
    expect(td.domain.chainId).toBe(84532);
    expect(td.domain.verifyingContract).toBe(gateway.config.easAddress);
    expect(td.message.schema).toBe(gateway.config.easConfirmationSchemaUid);
    // Resolver-required recipient: the payment's cached provider wallet.
    expect(td.message.recipient).toBe("0x000000000000000000000000000000000000c002");
    expect(td.message.expirationTime).toBe("0");
    // Boolean must be a real JSON boolean — viem's signTypedData rejects
    // the string form "true"/"false" for `bool`-typed fields.
    expect(td.message.revocable).toBe(true);
    expect(td.message.refUID).toMatch(/^0x0+$/);
    expect(td.message.data).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(td.message.value).toBe("0");
    expect(td.message.nonce).toBe("17");
    expect(td.message.deadline).toBe(body.deadline);

    expect(body.submitTemplate.confirmation).toBe("Confirmed");
    expect(body.submitTemplate.attester).toBe(attester);
  });

  it("rejects bad confirmation labels and malformed attester", async () => {
    const attester = ("0x" + "aa".repeat(20)) as Hex;
    let res = await fetch(
      `${gateway.baseUrl}/confirm-prep/1?confirmation=Pending&attester=${attester}`,
    );
    expect(res.status).toBe(400);
    res = await fetch(
      `${gateway.baseUrl}/confirm-prep/1?confirmation=Confirmed&attester=not-hex`,
    );
    expect(res.status).toBe(400);
    res = await fetch(
      `${gateway.baseUrl}/confirm-prep/not-a-number?confirmation=Confirmed&attester=${attester}`,
    );
    expect(res.status).toBe(400);
  });

  it("typed-data signs against the buyer key and the same nonce verify", async () => {
    const account = privateKeyToAccount(TEST_BUYER_KEY);
    gateway.mockChain.setEasAttesterNonce(account.address as Hex, 3n);

    const res = await fetch(
      `${gateway.baseUrl}/confirm-prep/99?confirmation=NotConfirmed&attester=${account.address}`,
    );
    const body = (await res.json()) as any;
    const td = body.eip712TypedData;

    const signature = (await account.signTypedData({
      domain: td.domain,
      types: { Attest: td.types.Attest },
      primaryType: "Attest",
      message: {
        schema: td.message.schema,
        recipient: td.message.recipient,
        expirationTime: BigInt(td.message.expirationTime),
        revocable: td.message.revocable === "true",
        refUID: td.message.refUID,
        data: td.message.data,
        value: BigInt(td.message.value),
        nonce: BigInt(td.message.nonce),
        deadline: BigInt(td.message.deadline),
      },
    })) as Hex;

    const valid = await verifyTypedData({
      address: account.address,
      domain: td.domain,
      types: { Attest: td.types.Attest },
      primaryType: "Attest",
      message: {
        schema: td.message.schema,
        recipient: td.message.recipient,
        expirationTime: BigInt(td.message.expirationTime),
        revocable: td.message.revocable === "true",
        refUID: td.message.refUID,
        data: td.message.data,
        value: BigInt(td.message.value),
        nonce: BigInt(td.message.nonce),
        deadline: BigInt(td.message.deadline),
      },
      signature,
    });
    expect(valid).toBe(true);
  });
});

// /capability-prep/dns moved to the provider in v4 — see
// daski-provider/src/adapters/domainManagement/skills/prepareDnsCapability.ts.
// Provider-side coverage lives in daski-provider/test/capability.test.ts.
