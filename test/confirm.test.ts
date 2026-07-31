import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";
import { reconcileBuyerConfirmations } from "../src/payment/confirmationReconciler.js";
import {
  signedConfirmation,
  TEST_BUYER,
} from "./helpers/confirmation.js";

const BUYER = TEST_BUYER;
const TX_HASH =
  "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex;
const ATTEST_UID =
  "0xcafe000000000000000000000000000000000000000000000000000000000001" as Hex;

const PROVIDER_WALLET =
  "0x000000000000000000000000000000000000c002" as Hex;

async function postSignedConfirmation(
  gateway: TestGateway,
  input: {
    paymentId?: bigint;
    confirmation?: "Confirmed" | "NotConfirmed";
    easNonce?: bigint;
    deadline?: bigint;
    refUid?: Hex | null;
  } = {},
): Promise<Response> {
  const paymentId = input.paymentId ?? 42n;
  return fetch(`${gateway.baseUrl}/confirm/${paymentId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await signedConfirmation(gateway.config, {
        paymentId,
        confirmation: input.confirmation ?? "Confirmed",
        recipient: PROVIDER_WALLET,
        easNonce: input.easNonce,
        deadline: input.deadline,
        refUid: input.refUid,
      }),
    ),
  });
}

function currentReputation(uid: Hex) {
  return {
    paymentId: 42n,
    providerAgentId: 2n,
    buyerAgentId: 7n,
    serviceId: ("0x" + "cd".repeat(32)) as Hex,
    outcome: "Completed" as const,
    confirmation: "Confirmed" as const,
    fulfillmentSeconds: 1n,
    outcomeTimestamp: 1n,
    confirmationTimestamp: 1n,
    currentConfirmationUid: uid,
    outcomeRecorded: true,
    reputationEligible: true,
  };
}

describe("POST /confirm/:paymentId", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: 2n,
          name: "Daski Test",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
    // The v0.6.0 resolver requires the confirmation recipient to be the
    // payment's cached provider wallet, so /confirm now reads the router
    // record before building the attestation.
    gateway.mockChain.setPaymentRecord(42n, {
      buyerAgentId: 7n,
      providerAgentId: 2n,
      serviceId: ("0x" + "cd".repeat(32)) as Hex,
      token: "0x000000000000000000000000000000000000a003" as Hex,
      amount: 1_000_000n,
      cachedBuyerWallet: BUYER,
      cachedProviderOwner: "0x000000000000000000000000000000000000c001" as Hex,
      cachedProviderWallet: PROVIDER_WALLET,
      serviceRef: ("0x" + "ab".repeat(32)) as Hex,
      paidAt: BigInt(Math.floor(Date.now() / 1000)),
      reputationEligible: true,
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("forwards signed delegation to the chain and returns attestation UID", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedConfirmation(gateway.config, {
          paymentId: 42n,
          confirmation: "Confirmed",
          recipient: PROVIDER_WALLET,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.paymentId).toBe("42");
    expect(body.confirmation).toBe("Confirmed");
    expect(body.attestationUid).toBe(ATTEST_UID);
    expect(body.transactionHash).toBe(TX_HASH);
    expect(body.refUid).toBeNull();

    // Verify the reader was called with the right schema + payload.
    expect(gateway.mockChain.confirmations).toHaveLength(1);
    const submitted = gateway.mockChain.confirmations[0];
    expect(submitted.attester.toLowerCase()).toBe(BUYER.toLowerCase());
    expect(submitted.schema.toLowerCase()).toBe(
      gateway.config.easConfirmationSchemaUid.toLowerCase(),
    );
    expect(submitted.revocable).toBe(true);
    expect(submitted.refUID.toLowerCase()).toBe(
      ("0x" + "00".repeat(32)).toLowerCase(),
    );
  });

  it("passes refUid for revision path", async () => {
    const priorUid =
      "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex;
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    gateway.mockChain.setReputationRecord(42n, {
      paymentId: 42n,
      providerAgentId: 2n,
      buyerAgentId: 7n,
      serviceId: ("0x" + "cd".repeat(32)) as Hex,
      outcome: "Completed",
      confirmation: "Confirmed",
      fulfillmentSeconds: 1n,
      outcomeTimestamp: 1n,
      confirmationTimestamp: 1n,
      currentConfirmationUid: priorUid,
      outcomeRecorded: true,
      reputationEligible: true,
    });

    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedConfirmation(gateway.config, {
          paymentId: 42n,
          confirmation: "NotConfirmed",
          recipient: PROVIDER_WALLET,
          refUid: priorUid,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.confirmation).toBe("NotConfirmed");
    expect(body.refUid).toBe(priorUid);

    const submitted = gateway.mockChain.confirmations[0];
    expect(submitted.refUID.toLowerCase()).toBe(priorUid.toLowerCase());
  });

  it("rejects Pending confirmation", async () => {
    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "Pending",
        attester: BUYER,
        deadline: "0",
        signature: { v: 27, r: ATTEST_UID, s: ATTEST_UID },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects bad paymentId", async () => {
    const res = await fetch(`${gateway.baseUrl}/confirm/not-a-number`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "Confirmed",
        attester: BUYER,
        easNonce: "0",
        deadline: "0",
        signature: { v: 27, r: ATTEST_UID, s: ATTEST_UID },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a sanitized failure when the chain reader throws", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "revert",
      reason: "attestByDelegation reverted: bad signature",
    });

    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedConfirmation(gateway.config, {
          paymentId: 42n,
          confirmation: "Confirmed",
          recipient: PROVIDER_WALLET,
        }),
      ),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("submit_failed");
    expect(body.error.message).toMatch(
      /^confirmation submission failed \(reference: [0-9a-f-]+\)$/,
    );
    expect(body.error.message).not.toContain("bad signature");
  });

  // The one `submit_failed` code used to cover a pre-broadcast revert, an
  // in-flight transaction of unknown outcome, and a SUCCESSFUL on-chain
  // attestation we failed to read back. Only the first is safe to retry
  // with the same signed inputs, so each stage must say so distinctly.
  async function postConfirm(): Promise<any> {
    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedConfirmation(gateway.config, {
          paymentId: 42n,
          confirmation: "Confirmed",
          recipient: PROVIDER_WALLET,
        }),
      ),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("marks a pre-broadcast revert retryable with the signature unconsumed", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "validation",
      reason: "EAS.attestByDelegation reverted: NotPayable()",
    });
    const { status, body } = await postConfirm();
    expect(status).toBe(400);
    expect(body.error.code).toBe("submit_rejected");
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).not.toContain("NotPayable");
  });

  it("tells a deadline/nonce revert to re-sign instead of retrying", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "validation",
      reason: "EAS.attestByDelegation reverted: DeadlineExpired()",
      needsFreshSignature: true,
    });
    const { body } = await postConfirm();
    expect(body.error.code).toBe("confirmation_signature_invalid");
    expect(body.error.retryable).toBeUndefined();
    expect(body.error.message).not.toContain("DeadlineExpired");
  });

  it("refuses to call a post-broadcast failure retryable", async () => {
    const transactionHash = `0x${"ab".repeat(32)}` as Hex;
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "unknown",
      reason: "receipt unavailable",
      txHash: transactionHash,
    });
    const { status, body } = await postConfirm();
    expect(status).toBe(503);
    expect(body.error.code).toBe("confirmation_reconciliation_pending");
    expect(body.error.retryable).toBe(true);

    const active =
      await gateway.bundle.queries.getActiveConfirmationSubmission(42n);
    gateway.mockChain.resolveConfirmation(transactionHash, {
      transactionHash,
      attestationUid: ATTEST_UID,
    });
    await gateway.bundle.pool.query(
      `UPDATE facilitator_transactions
          SET next_attempt_at = now()
        WHERE id = $1`,
      [active!.facilitatorTransactionId],
    );
    expect(
      await reconcileBuyerConfirmations(
        gateway.mockChain,
        gateway.bundle.queries,
        gateway.bundle.reputationWorker,
        gateway.config,
      ),
    ).toEqual({ scanned: 1, recovered: 1 });
    expect(
      await gateway.bundle.queries.getConfirmationSubmissionByHash(
        active!.requestHash,
      ),
    ).toMatchObject({ status: "confirmed", attestationUid: ATTEST_UID });
  });

  it("surfaces an attested-but-unrecorded confirmation as its own failure", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "attestation",
      reason: "Attested event not found",
      txHash: `0x${"cd".repeat(32)}` as `0x${string}`,
    });
    const { status, body } = await postConfirm();
    expect(status).toBe(503);
    expect(body.error.code).toBe("confirmation_reconciliation_pending");
    expect(body.error.retryable).toBe(true);
  });

  it("rejects an invalid typed-data signature without consuming sponsorship", async () => {
    const body = await signedConfirmation(gateway.config, {
      paymentId: 42n,
      confirmation: "Confirmed",
      recipient: PROVIDER_WALLET,
    });
    body.signature = {
      v: 27,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
    };
    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "confirmation_signature_invalid" },
    });
    expect(
      await gateway.bundle.queries.countConfirmationSubmissions(42n),
    ).toBe(0);
    expect(gateway.mockChain.confirmations).toHaveLength(0);
  });

  it("rejects a stale EAS nonce before preparing a facilitator transaction", async () => {
    const res = await postSignedConfirmation(gateway, { easNonce: 1n });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "confirmation_nonce_stale" },
    });
    expect(gateway.mockChain.confirmations).toHaveLength(0);
  });

  it("sponsors one initial confirmation and two revisions, then rejects a fourth", async () => {
    let currentUid: Hex | null = null;
    for (let index = 0; index < 3; index++) {
      const uid = `0xcafe${String(index + 1).padStart(60, "0")}` as Hex;
      const transactionHash =
        `0xdead${String(index + 1).padStart(60, "0")}` as Hex;
      if (currentUid) {
        gateway.mockChain.setReputationRecord(
          42n,
          currentReputation(currentUid),
        );
      }
      gateway.mockChain.queueConfirmation({
        kind: "success",
        txHash: transactionHash,
        attestationUid: uid,
      });
      const res = await postSignedConfirmation(gateway, {
        confirmation: index === 1 ? "NotConfirmed" : "Confirmed",
        easNonce: BigInt(index),
        refUid: currentUid,
      });
      expect(res.status).toBe(200);
      currentUid = uid;
    }
    gateway.mockChain.setReputationRecord(
      42n,
      currentReputation(currentUid!),
    );
    const rejected = await postSignedConfirmation(gateway, {
      easNonce: 3n,
      refUid: currentUid,
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "confirmation_revision_limit" },
    });
    expect(gateway.mockChain.confirmations).toHaveLength(3);
    expect(
      await gateway.bundle.queries.countConfirmationSubmissions(42n),
    ).toBe(3);
  });

  it("returns Retry-After when the wallet daily sponsorship limit is exhausted", async () => {
    await gateway.close();
    gateway = await startTestGateway({
      configOverrides: {
        confirmationMaxPerWalletPerDay: 1,
      },
      providers: [
        {
          tokenId: 2n,
          name: "Daski Test",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
    for (const paymentId of [42n, 43n]) {
      gateway.mockChain.setPaymentRecord(paymentId, {
        buyerAgentId: 7n,
        providerAgentId: 2n,
        serviceId: ("0x" + "cd".repeat(32)) as Hex,
        token: "0x000000000000000000000000000000000000a003" as Hex,
        amount: 1_000_000n,
        cachedBuyerWallet: BUYER,
        cachedProviderOwner:
          "0x000000000000000000000000000000000000c001" as Hex,
        cachedProviderWallet: PROVIDER_WALLET,
        serviceRef: ("0x" + "ab".repeat(32)) as Hex,
        paidAt: BigInt(Math.floor(Date.now() / 1000)),
        reputationEligible: true,
      });
    }
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    expect((await postSignedConfirmation(gateway)).status).toBe(200);
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: `0x${"ef".repeat(32)}` as Hex,
      attestationUid: `0x${"ad".repeat(32)}` as Hex,
    });
    const limited = await postSignedConfirmation(gateway, {
      paymentId: 43n,
      easNonce: 1n,
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(
      86_400,
    );
    expect(await limited.json()).toMatchObject({
      error: {
        code: "confirmation_sponsorship_limited",
        retryable: true,
      },
    });
    expect(
      await gateway.bundle.queries.countConfirmationSubmissions(43n),
    ).toBe(0);
  });

  it("returns Retry-After when global daily sponsorship is exhausted", async () => {
    await gateway.close();
    gateway = await startTestGateway({
      configOverrides: {
        confirmationMaxGlobalPerDay: 1,
      },
      providers: [
        {
          tokenId: 2n,
          name: "Daski Test",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
    });
    for (const paymentId of [42n, 43n]) {
      gateway.mockChain.setPaymentRecord(paymentId, {
        buyerAgentId: 7n,
        providerAgentId: 2n,
        serviceId: ("0x" + "cd".repeat(32)) as Hex,
        token: "0x000000000000000000000000000000000000a003" as Hex,
        amount: 1_000_000n,
        cachedBuyerWallet: BUYER,
        cachedProviderOwner:
          "0x000000000000000000000000000000000000c001" as Hex,
        cachedProviderWallet: PROVIDER_WALLET,
        serviceRef: ("0x" + "ab".repeat(32)) as Hex,
        paidAt: BigInt(Math.floor(Date.now() / 1000)),
        reputationEligible: true,
      });
    }
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    expect((await postSignedConfirmation(gateway)).status).toBe(200);
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: `0x${"ef".repeat(32)}` as Hex,
      attestationUid: `0x${"ad".repeat(32)}` as Hex,
    });

    const limited = await postSignedConfirmation(gateway, {
      paymentId: 43n,
      easNonce: 1n,
    });

    expect(limited.status).toBe(503);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({
      error: {
        code: "confirmation_sponsorship_unavailable",
        retryable: true,
      },
    });
    expect(
      await gateway.bundle.queries.countConfirmationSubmissions(43n),
    ).toBe(0);
  });

  it("blocks a non-identical submission while a confirmation is unresolved", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "unknown",
      reason: "receipt unavailable",
      txHash: `0x${"bc".repeat(32)}` as Hex,
    });
    expect((await postSignedConfirmation(gateway)).status).toBe(503);
    const conflicting = await postSignedConfirmation(gateway, {
      confirmation: "NotConfirmed",
    });
    expect(conflicting.status).toBe(503);
    expect(await conflicting.json()).toMatchObject({
      error: {
        code: "confirmation_reconciliation_pending",
        retryable: true,
      },
    });
    expect(gateway.mockChain.confirmations).toHaveLength(1);
  });

  it("allows a new signed request to reuse an EAS nonce left unconsumed by a mined revert", async () => {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "reverted",
      reason: "transaction reverted",
      txHash: `0x${"ba".repeat(32)}` as Hex,
    });
    const reverted = await postSignedConfirmation(gateway, {
      deadline: now + 3_600n,
    });
    expect(reverted.status).toBe(400);
    expect(await reverted.json()).toMatchObject({
      error: { code: "submit_reverted" },
    });
    expect(await gateway.mockChain.getEasAttesterNonce(BUYER)).toBe(0n);

    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: `0x${"bb".repeat(32)}` as Hex,
      attestationUid: ATTEST_UID,
    });
    const retried = await postSignedConfirmation(gateway, {
      deadline: now + 3_700n,
    });
    expect(retried.status).toBe(200);
    expect(
      await gateway.bundle.queries.countConfirmationSubmissions(42n),
    ).toBe(2);
    const rows = await gateway.bundle.pool.query<{
      status: string;
      transaction_nonce: string;
    }>(
      `SELECT transaction.status, transaction.transaction_nonce::text
         FROM buyer_confirmation_submissions AS submission
         JOIN facilitator_transactions AS transaction
           ON transaction.id = submission.facilitator_transaction_id
        WHERE submission.payment_id = 42
        ORDER BY submission.created_at`,
    );
    expect(rows.rows).toEqual([
      { status: "reverted", transaction_nonce: "0" },
      { status: "succeeded", transaction_nonce: "1" },
    ]);
  });
});
