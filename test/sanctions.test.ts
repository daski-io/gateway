import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { encodeErrorResult, toFunctionSelector } from "viem";
import {
  classifySettlementScreeningFailure,
  sanctionsErrorAbi,
  SettlementScreeningError,
} from "../src/chain/sanctionsErrors.js";
import { DASKI_X402_EXTENSION_URI } from "../src/config.js";
import type { Hex, PaymentRequired } from "../src/types.js";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import { reconcileBroadcastSettlements } from "../src/payment/settlementReconciler.js";

const SANCTIONED_ACCOUNT = "0x00000000000000000000000000000000000000aa" as Hex;
const ORACLE = "0x00000000000000000000000000000000000000bb" as Hex;
const REJECTED_SELECTOR = toFunctionSelector("SanctionedAddress(address)");
const UNAVAILABLE_SELECTOR = toFunctionSelector(
  "SanctionsOracleUnavailable(address)",
);

describe("sanctions error decoding", () => {
  it("decodes only exact ABI revert data", () => {
    const data = encodeErrorResult({
      abi: sanctionsErrorAbi,
      errorName: "SanctionedAddress",
      args: [SANCTIONED_ACCOUNT],
    });
    expect(classifySettlementScreeningFailure({ cause: { data } })).toEqual({
      code: "SANCTIONS_ADDRESS_REJECTED",
      retryable: false,
      selector: data.slice(0, 10),
      account: SANCTIONED_ACCOUNT,
    });
    expect(
      classifySettlementScreeningFailure(
        new Error(
          `execution reverted: SanctionedAddress(${SANCTIONED_ACCOUNT})`,
        ),
      ),
    ).toBeNull();
  });

  it("classifies oracle availability separately", () => {
    const data = encodeErrorResult({
      abi: sanctionsErrorAbi,
      errorName: "SanctionsOracleUnavailable",
      args: [ORACLE],
    });
    expect(classifySettlementScreeningFailure({ data })).toEqual({
      code: "SANCTIONS_SCREENING_UNAVAILABLE",
      retryable: true,
      selector: data.slice(0, 10),
      oracle: ORACLE,
    });
  });
});

describe("sanctions settlement lifecycle", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Screened service",
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

  async function paymentPayload(paymentRequired: PaymentRequired) {
    return gateway.createPaymentPayload(paymentRequired);
  }

  it("persists terminal evidence and returns a stable buyer-safe rejection", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    gateway.mockChain.queueSettlement({
      kind: "screening-error",
      detectionSource: "simulation",
      failure: {
        code: "SANCTIONS_ADDRESS_REJECTED",
        retryable: false,
        selector: REJECTED_SELECTOR,
        account: SANCTIONED_ACCOUNT,
      },
    });

    const payload = await paymentPayload(challenge.paymentRequired!);
    const first = await gateway.purchaseSettle(2n, payload);
    expect(first.status).toBe(402);
    expect(first.json).toMatchObject({
      success: false,
      errorReason: "SANCTIONS_ADDRESS_REJECTED",
      errorMessage: "This payment cannot be processed.",
      retryable: false,
      extensions: {
        [DASKI_X402_EXTENSION_URI]: {
          screening: {
            code: "SANCTIONS_ADDRESS_REJECTED",
            retryable: false,
          },
        },
      },
    });
    expect(JSON.stringify(first.json)).not.toContain(SANCTIONED_ACCOUNT);
    expect(
      (await gateway.bundle.queries.getChallengeByRef(challenge.serviceRef!))
        ?.settlementState,
    ).toBe("sanctions_rejected");

    gateway.mockChain.setSanctionsReady(false);
    const repeated = await gateway.purchaseSettle(2n, payload);
    expect(repeated.status).toBe(402);
    expect(repeated.json.errorReason).toBe("SANCTIONS_ADDRESS_REJECTED");

    const purchase = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": encodePaymentSignatureHeader(payload),
      },
      body: JSON.stringify(challenge.requestBody),
    });
    expect(purchase.status).toBe(402);
    expect(await purchase.json()).toMatchObject({
      error: "SANCTIONS_ADDRESS_REJECTED",
      message: "This payment cannot be processed.",
      retryable: false,
    });
    expect(
      decodePaymentResponseHeader(purchase.headers.get("payment-response")!)
        .extensions?.[DASKI_X402_EXTENSION_URI],
    ).toMatchObject({
      screening: {
        code: "SANCTIONS_ADDRESS_REJECTED",
        retryable: false,
      },
    });
  });

  it("records oracle outages as retryable without terminal rejection", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    gateway.mockChain.queueSettlement({
      kind: "screening-error",
      detectionSource: "simulation",
      failure: {
        code: "SANCTIONS_SCREENING_UNAVAILABLE",
        retryable: true,
        selector: UNAVAILABLE_SELECTOR,
        oracle: ORACLE,
      },
    });

    const payload = await paymentPayload(challenge.paymentRequired!);
    const result = await gateway.purchaseSettle(2n, payload);
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({
      errorReason: "SANCTIONS_SCREENING_UNAVAILABLE",
      errorMessage:
        "Payment cannot be processed right now. Please try again later.",
      retryable: true,
    });
    expect(
      (await gateway.bundle.queries.getChallengeByRef(challenge.serviceRef!))
        ?.settlementState,
    ).toBe("pending");

    gateway.mockChain.queueSettlement({
      kind: "screening-error",
      detectionSource: "simulation",
      failure: {
        code: "SANCTIONS_SCREENING_UNAVAILABLE",
        retryable: true,
        selector: UNAVAILABLE_SELECTOR,
        oracle: ORACLE,
      },
    });
    const purchase = await fetch(`${gateway.baseUrl}/purchase/2`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": encodePaymentSignatureHeader(payload),
      },
      body: JSON.stringify(challenge.requestBody),
    });
    expect(purchase.status).toBe(503);
    expect(await purchase.json()).toMatchObject({
      error: "SANCTIONS_SCREENING_UNAVAILABLE",
      retryable: true,
    });
    const events = await gateway.bundle.pool.query<{
      occurrence_count: number;
    }>(
      `SELECT occurrence_count
         FROM settlement_screening_events
        WHERE service_ref = $1`,
      [Buffer.from(challenge.serviceRef!.slice(2), "hex")],
    );
    expect(events.rows[0]?.occurrence_count).toBe(2);
  });

  it("fails paid challenge issuance while screening is unready", async () => {
    gateway.mockChain.setSanctionsReady(false);
    const result = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    expect(result.status).toBe(503);
    expect(result.json.error).toBe(
      "Payment cannot be processed right now. Please try again later.",
    );
  });

  it("reconciles a broadcast receipt into terminal sanctions evidence", async () => {
    const challenge = await gateway.purchaseChallenge(2n, {
      buyerTokenId: "5",
    });
    const transactionHash = `0x${"cd".repeat(32)}` as Hex;
    await gateway.bundle.queries.recordChallengeTransactionPrepared(
      challenge.serviceRef!,
      transactionHash,
      "0x0201",
      0n,
    );
    await gateway.bundle.queries.recordChallengeTransactionBroadcast(
      challenge.serviceRef!,
      transactionHash,
    );
    gateway.mockChain.setSettlementRecoveryError(
      transactionHash,
      new SettlementScreeningError(
        {
          code: "SANCTIONS_ADDRESS_REJECTED",
          retryable: false,
          selector: REJECTED_SELECTOR,
          account: SANCTIONED_ACCOUNT,
        },
        "receipt_replay",
        transactionHash,
      ),
    );

    expect(
      await reconcileBroadcastSettlements(
        gateway.mockChain,
        gateway.bundle.queries,
        gateway.config,
      ),
    ).toEqual({ scanned: 1, recovered: 0 });
    expect(
      (await gateway.bundle.queries.getChallengeByRef(challenge.serviceRef!))
        ?.settlementState,
    ).toBe("sanctions_rejected");
  });
});
