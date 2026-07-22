import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverTypedDataAddress, verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";

const TEST_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

// ── Inline EIP-712 typed-data on /purchase 402 ─────────────────────────────

describe("PaymentRequirements inline eip712TypedData", () => {
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

  it("includes a fully-baked typed-data block bound to the agent's wallet", async () => {
    const { json, status, serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    expect(status).toBe(402);
    expect(serviceRef).toBeDefined();

    const td = json.accepts[0].extra.daski.eip712TypedData;
    expect(td.primaryType).toBe("TransferWithAuthorization");
    expect(td.types.TransferWithAuthorization).toEqual([
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ]);
    expect(td.domain.name).toBe("USDC");
    expect(td.domain.version).toBe("2");
    expect(td.domain.chainId).toBe(84532);
    expect(td.domain.verifyingContract).toBe(gateway.config.usdcAddress);

    expect(td.message.from.toLowerCase()).toBe(gateway.buyerAddress);
    expect(td.message.to).toBe(gateway.config.paymentRouterAddress);
    expect(td.message.value).toBe("15000000");
    expect(td.message.validAfter).toBe("0");
    expect(Number(td.message.validBefore)).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(td.message.nonce).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("baked typed-data signs cleanly and settles end-to-end (wallet-agnostic flow)", async () => {
    const { json, serviceRef } = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const td = json.accepts[0].extra.daski.eip712TypedData;

    // Sign with a stand-in viem account — proves any EIP-712-capable wallet
    // can complete the flow without knowing Daski's schemas.
    const account = privateKeyToAccount(TEST_BUYER_KEY);
    const signature = (await account.signTypedData({
      domain: td.domain,
      types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
      primaryType: "TransferWithAuthorization",
      message: {
        from: td.message.from,
        to: td.message.to,
        value: BigInt(td.message.value),
        validAfter: BigInt(td.message.validAfter),
        validBefore: BigInt(td.message.validBefore),
        nonce: td.message.nonce,
      },
    })) as Hex;

    // Sanity: the signature recovers to the wallet baked into `from`
    const recovered = await recoverTypedDataAddress({
      domain: td.domain,
      types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
      primaryType: "TransferWithAuthorization",
      message: {
        from: td.message.from,
        to: td.message.to,
        value: BigInt(td.message.value),
        validAfter: BigInt(td.message.validAfter),
        validBefore: BigInt(td.message.validBefore),
        nonce: td.message.nonce,
      },
      signature,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(recovered.toLowerCase()).toBe(td.message.from.toLowerCase());

    // Settle through the canonical facilitator API using the exact
    // gateway-baked message.
    gateway.queueSettlementSuccess({
      txHash: ("0x" + "ab".repeat(32)) as Hex,
      paymentId: 7n,
      serviceRef: serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 15_000_000n,
    });
    const settled = await gateway.purchaseSettle(2n, {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: {
        signature,
        authorization: {
          from: td.message.from,
          to: td.message.to,
          value: td.message.value,
          validAfter: td.message.validAfter,
          validBefore: td.message.validBefore,
          nonce: td.message.nonce,
        },
      },
    });
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
    expect(td.message.recipient).toBe("0x0000000000000000000000000000000000000000");
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
