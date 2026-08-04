import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASKI_X402_EXTENSION_URI } from "../src/config.js";
import type { Hex } from "../src/types.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { makePaymentSettledEvent } from "./helpers/mockChain.js";

const TX =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

describe("x402 V2 facilitator API", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Provider",
          priceUsdcSmallest: "100000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
  });

  afterEach(async () => gateway.close());

  async function fixture() {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const payload = await gateway.createPaymentPayload(
      challenge.paymentRequired!,
    );
    return {
      challenge,
      payload,
      requirements: challenge.paymentRequired!.accepts[0]!,
    };
  }

  it("verifies a Daski receive payload", async () => {
    const value = await fixture();
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isValid: true,
      payer: gateway.buyerAddress,
    });
    expect(gateway.mockChain.simulations).toHaveLength(0);
  });

  it("does not invent a payer for an unreadable compact payload", async () => {
    const value = await fixture();
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          serviceRef: value.challenge.serviceRef,
          payload: null,
        },
        paymentRequirements: value.requirements,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      isValid: false,
      invalidReason: "invalid_payment_payload",
    });
    expect(body).not.toHaveProperty("payer");
    expect(JSON.stringify(body)).not.toContain(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("keeps contract-wallet signatures opaque", async () => {
    const value = await fixture();
    (value.payload.payload as { signature: Hex }).signature = "0x1234";
    gateway.mockChain.verifyReceiveAuthorization = async (input) => {
      expect(input.signature).toBe("0x1234");
      return true;
    };

    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(await response.json()).toMatchObject({
      isValid: true,
      payer: gateway.buyerAddress,
    });
  });

  it("rejects a nonce not bound to the issued route", async () => {
    const value = await fixture();
    (
      value.payload.payload as { authorization: { nonce: Hex } }
    ).authorization.nonce = `0x${"ab".repeat(32)}` as Hex;

    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization",
    });
  });

  it("rejects an authorization that outlives the issued challenge", async () => {
    const value = await fixture();
    const extended = structuredClone(value.challenge.paymentRequired!);
    const extra = extended.accepts[0]!.extra!;
    extra.authorizationValidBefore = (
      BigInt(String(extra.authorizationValidBefore)) + 3_600n
    ).toString();
    const signed = await gateway.createPaymentPayload(extended);
    value.payload.payload = signed.payload;
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_evm_payload_authorization_valid_before",
    });
  });

  it("rejects changed accepted requirements", async () => {
    const value = await fixture();
    value.payload.accepted = {
      ...value.payload.accepted,
      amount: "1",
    };
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "payment_requirements_mismatch",
      invalidMessage: expect.stringContaining("accepted.amount"),
    });
  });

  it("rejects deletion of server-declared extension info", async () => {
    const value = await fixture();
    const extension = value.payload.extensions?.[
      DASKI_X402_EXTENSION_URI
    ] as any;
    delete extension.info.quote;
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "extension_echo_mismatch",
      invalidMessage: expect.stringContaining("extensions.daski.info.quote"),
    });
  });

  it("settles through the Daski adapter backend", async () => {
    const value = await fixture();
    let verifyCalls = 0;
    const verify = gateway.mockChain.verifyReceiveAuthorization.bind(
      gateway.mockChain,
    );
    gateway.mockChain.verifyReceiveAuthorization = async (input) => {
      verifyCalls += 1;
      return verify(input);
    };
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 88n,
      serviceRef: value.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    const response = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(response.status).toBe(200);
    const settled = (await response.json()) as any;
    expect(settled).toMatchObject({
      success: true,
      transaction: TX,
      network: "eip155:84532",
      amount: "100000",
    });
    expect(settled.extensions[DASKI_X402_EXTENSION_URI].paymentId).toBe("88");
    expect(gateway.mockChain.simulations).toHaveLength(1);
    expect(gateway.mockChain.simulations[0]?.serviceRef).toBe(
      value.challenge.serviceRef,
    );
    expect(verifyCalls).toBe(1);
  });

  it("rejects quotes and stored challenges below the settlement floor", async () => {
    gateway.config.settlementMinAmount = 100_001n;
    const rejected = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toMatch(/settlement minimum/);

    gateway.config.settlementMinAmount = 1n;
    const value = await fixture();
    gateway.config.settlementMinAmount = 100_001n;
    const response = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      errorReason: "settlement_amount_below_minimum",
    });
    expect(gateway.mockChain.simulations).toHaveLength(0);
  });

  it("stops settlement when the facilitator reserve is below its floor", async () => {
    const value = await fixture();
    gateway.config.facilitatorMinBalanceWei = 10n;
    gateway.mockChain.facilitatorBalance = 10n;
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 88n,
      serviceRef: value.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    const response = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      errorReason: "facilitator_balance_low",
      retryable: true,
    });
    expect(gateway.mockChain.settlements).toHaveLength(0);
  });

  it("enforces the durable daily settlement sponsorship ceiling", async () => {
    gateway.config.settlementMaxPerWalletPerDay = 2;
    gateway.config.settlementMaxGlobalPerDay = 1;
    const first = await fixture();
    const second = await fixture();
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 88n,
      serviceRef: first.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    gateway.queueSettlementSuccess({
      txHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      paymentId: 89n,
      serviceRef: second.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    const settle = (value: Awaited<ReturnType<typeof fixture>>) =>
      fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: value.payload,
          paymentRequirements: value.requirements,
        }),
      });

    expect((await settle(first)).status).toBe(200);
    const rejected = await settle(second);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      errorReason: "settlement_sponsorship_unavailable",
      retryable: true,
    });
    const global = await gateway.bundle.pool.query<{
      sponsorship_count: number;
    }>(
      `SELECT sponsorship_count
         FROM settlement_sponsorship_buckets
        WHERE bucket_key = 'global'`,
    );
    expect(global.rows[0]?.sponsorship_count).toBe(1);
    expect(gateway.mockChain.settlements).toHaveLength(1);
  });

  it("retries the same signed transaction after submission fails", async () => {
    const value = await fixture();
    gateway.mockChain.queueSettlement({
      kind: "submission-error",
      txHash: TX,
      event: {
        paymentId: 88n,
        serviceRef: value.challenge.serviceRef!,
        serviceId: value.challenge.paymentRequired!.accepts[0]!.extra!
          .serviceId as Hex,
        buyerAgentId: 5n,
        providerAgentId: 2n,
        token: gateway.config.usdc.address,
        totalAmount: 100_000n,
        providerAmount: 95_000n,
        commission: 5_000n,
      },
      reason: "RPC submission failed",
    });
    const settle = () =>
      fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: value.payload,
          paymentRequirements: value.requirements,
        }),
      });

    const first = await settle();
    expect(first.status).toBe(503);
    const prepared = await gateway.bundle.queries.getChallengeByRef(
      value.challenge.serviceRef!,
    );
    expect(prepared).toMatchObject({
      settlementState: "settlement_prepared",
      transactionHash: TX,
      settlementFacilitatorTransactionId: expect.any(String),
    });
    const journal =
      await gateway.bundle.queries.getFacilitatorTransactionById(
        prepared!.settlementFacilitatorTransactionId!,
      );
    expect(journal).toMatchObject({
      transactionNonce: 0n,
      preparedTransaction: expect.any(String),
    });

    expect((await settle()).status).toBe(200);
    expect(gateway.mockChain.simulations).toHaveLength(1);
    expect(
      (
        await gateway.bundle.queries.getChallengeByRef(
          value.challenge.serviceRef!,
        )
      )?.settlementState,
    ).toBe("paid");
  });

  it("recovers a submitted transaction when broadcast persistence fails", async () => {
    const value = await fixture();
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 88n,
      serviceRef: value.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    const record =
      gateway.bundle.queries.recordChallengeTransactionBroadcast.bind(
        gateway.bundle.queries,
      );
    let failOnce = true;
    gateway.bundle.queries.recordChallengeTransactionBroadcast = async (
      client,
      serviceRef,
      transactionId,
      transactionHash,
    ) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("database write failed");
      }
      return record(client, serviceRef, transactionId, transactionHash);
    };
    const settle = () =>
      fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: value.payload,
          paymentRequirements: value.requirements,
        }),
      });

    expect((await settle()).status).toBe(503);
    expect((await settle()).status).toBe(200);
    expect(gateway.mockChain.simulations).toHaveLength(1);
    expect(gateway.mockChain.settlements).toHaveLength(1);
  });

  it("does not consume submission attempts after broadcast", async () => {
    const value = await fixture();
    gateway.mockChain.queueSettlement({
      kind: "broadcast-error",
      txHash: TX,
      event: makePaymentSettledEvent({
        paymentId: 88n,
        serviceRef: value.challenge.serviceRef!,
        buyerAgentId: 5n,
        providerAgentId: 2n,
        totalAmount: 100_000n,
      }),
      reason: "receipt unavailable",
    });
    const settle = () =>
      fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: value.payload,
          paymentRequirements: value.requirements,
        }),
      });

    expect((await settle()).status).toBe(503);
    const challenge = await gateway.bundle.queries.getChallengeByRef(
      value.challenge.serviceRef!,
    );
    const transactionId = challenge!.settlementFacilitatorTransactionId!;
    expect(
      await gateway.bundle.queries.getFacilitatorTransactionById(transactionId),
    ).toMatchObject({
      status: "broadcast",
      submissionAttempts: 1,
    });

    gateway.mockChain.findSettlementByTransaction = async () => null;
    expect((await settle()).status).toBe(503);
    expect(
      await gateway.bundle.queries.getFacilitatorTransactionById(transactionId),
    ).toMatchObject({
      status: "broadcast",
      submissionAttempts: 1,
    });
    expect(gateway.mockChain.settlements).toHaveLength(2);
  });

  it("blocks another challenge while a prepared transaction is unresolved", async () => {
    const first = await fixture();
    const second = await fixture();
    gateway.mockChain.queueSettlement({
      kind: "submission-error",
      txHash: TX,
      event: makePaymentSettledEvent({
        paymentId: 88n,
        serviceRef: first.challenge.serviceRef!,
        buyerAgentId: 5n,
        providerAgentId: 2n,
        totalAmount: 100_000n,
      }),
      reason: "RPC submission failed",
    });
    const settle = (value: Awaited<ReturnType<typeof fixture>>) =>
      fetch(`${gateway.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: value.payload,
          paymentRequirements: value.requirements,
        }),
      });

    expect((await settle(first)).status).toBe(503);
    const blocked = await settle(second);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({
      errorReason: "facilitator_transaction_pending",
      errorMessage:
        "the facilitator wallet is reconciling a prior transaction",
      retryable: true,
    });
    expect(gateway.mockChain.simulations).toHaveLength(1);
  });

  it("does not submit when prepared transaction persistence fails", async () => {
    const value = await fixture();
    gateway.queueSettlementSuccess({
      txHash: TX,
      paymentId: 88n,
      serviceRef: value.challenge.serviceRef!,
      providerAgentId: 2n,
      buyerAgentId: 5n,
      totalAmount: 100_000n,
    });
    gateway.bundle.queries.recordChallengeTransactionPrepared = async () =>
      false;

    const response = await fetch(`${gateway.baseUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
      }),
    });

    expect(response.status).toBe(503);
    expect(gateway.mockChain.simulations).toHaveLength(1);
    expect(gateway.mockChain.settlements).toHaveLength(0);
    expect(
      (
        await gateway.bundle.queries.getChallengeByRef(
          value.challenge.serviceRef!,
        )
      )?.settlementState,
    ).toBe("pending");
  });

  it("requires the exact V2 facilitator request envelope", async () => {
    const value = await fixture();
    const response = await fetch(`${gateway.baseUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload: value.payload,
        paymentRequirements: value.requirements,
        registration: {},
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_request",
    });
  });
});
