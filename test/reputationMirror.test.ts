import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";
import {
  signedConfirmation,
  TEST_BUYER,
} from "./helpers/confirmation.js";
import { ReputationProjectionMismatchError } from "../src/db/reputationTransactionQueries.js";
import { DatabaseReadinessProbe } from "../src/http/readiness.js";

// Canonical-feedback mirror (src/reputation/mirror.ts). The mirror is
// fire-and-forget from POST /confirm — these tests await its side effects
// (mock reader call records + the reputation_mirrors row) via vi.waitFor
// rather than the HTTP response.

const BUYER = TEST_BUYER;
const TX_HASH =
  "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex;
const ATTEST_UID =
  "0xcafe000000000000000000000000000000000000000000000000000000000001" as Hex;
const REVISED_UID =
  "0xcafe000000000000000000000000000000000000000000000000000000000002" as Hex;
// Distinct fixture address for the canonical ReputationRegistry so tests
// can't accidentally pass with a value that came from somewhere else.
const REPUTATION_REGISTRY =
  "0x000000000000000000000000000000000000b004" as Hex;
const PROVIDER_AGENT_ID = 2n;
const PAYMENT_ID = 42n;
const PROVIDER_WALLET =
  "0x000000000000000000000000000000000000c002" as Hex;

function paymentRecord(
  providerAgentId: bigint,
  reputationEligible = true,
) {
  return {
    buyerAgentId: 7n,
    providerAgentId,
    serviceId: ("0x" + "cd".repeat(32)) as Hex,
    token: "0x000000000000000000000000000000000000a003" as Hex,
    amount: 1_000_000n,
    cachedBuyerWallet: BUYER,
    cachedProviderOwner:
      "0x000000000000000000000000000000000000c001" as Hex,
    cachedProviderWallet: PROVIDER_WALLET,
    serviceRef: ("0x" + "ab".repeat(32)) as Hex,
    paidAt: BigInt(Math.floor(Date.now() / 1000)),
    reputationEligible,
  };
}

function reputationRecord(currentConfirmationUid: Hex) {
  return {
    paymentId: PAYMENT_ID,
    providerAgentId: PROVIDER_AGENT_ID,
    buyerAgentId: 7n,
    serviceId: ("0x" + "cd".repeat(32)) as Hex,
    outcome: "Completed" as const,
    confirmation: "Confirmed" as const,
    fulfillmentSeconds: 1n,
    outcomeTimestamp: 1n,
    confirmationTimestamp: 1n,
    currentConfirmationUid,
    outcomeRecorded: true,
    reputationEligible: true,
  };
}

async function postConfirm(
  gateway: TestGateway,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const confirmation =
    body.confirmation === "NotConfirmed" ? "NotConfirmed" : "Confirmed";
  const easNonce = BigInt(String(body.easNonce ?? "0"));
  const refUid = (body.refUid as Hex | undefined) ?? null;
  const deadline =
    body.deadline === undefined ? undefined : BigInt(String(body.deadline));
  const signed = await signedConfirmation(gateway.config, {
    paymentId: PAYMENT_ID,
    confirmation,
    recipient: PROVIDER_WALLET,
    easNonce,
    refUid,
    deadline,
  });
  const res = await fetch(`${gateway.baseUrl}/confirm/${PAYMENT_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...signed, ...body }),
  });
  return { status: res.status, json: await res.json() };
}

/** Insert a paid challenge row for PAYMENT_ID so the mirror can read the
 *  service slug for tag2 (and fall back to it for provider resolution). */
async function seedPaidChallenge(
  gateway: TestGateway,
  serviceSlug: string,
): Promise<void> {
  const serviceRef = ("0x" + "ab".repeat(32)) as Hex;
  await gateway.bundle.queries.insertChallenge({
    serviceRef,
    providerTokenId: PROVIDER_AGENT_ID,
    buyerTokenId: 7n,
    amount: 1_000_000n,
    skillId: "register-domain",
    serviceSlug,
    serviceVersion: "1",
    serviceId: ("0x" + "cd".repeat(32)) as Hex,
    providerA2AUrl: "http://provider.test/a2a",
    walletAddress: BUYER,
    expiresAt: new Date(Date.now() + 3600_000),
    providerAuthority: {
      walletAddress:
        "0x000000000000000000000000000000000000c002" as Hex,
      agentURI: "https://provider.test/agent.json",
      observedBlock: 0n,
    },
  });
  await gateway.bundle.queries.recordChallengePaid(
    serviceRef,
    PAYMENT_ID,
    TX_HASH,
  );
}

describe("canonical ReputationRegistry feedback mirror", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: PROVIDER_AGENT_ID,
          name: "Daski Test",
          priceUsdcSmallest: "1000000",
          categoryFamily: "other",
          serviceType: "other",
        },
      ],
      configOverrides: { reputationRegistryAddress: REPUTATION_REGISTRY },
    });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("mirrors a confirmation as exactly one giveFeedback with the locked convention", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    await seedPaidChallenge(gateway, "domain-mgmt");
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await postConfirm(gateway, { confirmation: "Confirmed" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(gateway.mockChain.feedbacks).toHaveLength(1);
    });
    const fb = gateway.mockChain.feedbacks[0]!;
    expect(fb.agentId).toBe(PROVIDER_AGENT_ID);
    expect(fb.value).toBe(100n);
    expect(fb.valueDecimals).toBe(0);
    expect(fb.tag1).toBe("daski");
    expect(fb.tag2).toBe("domain-mgmt");
    expect(fb.endpoint).toBe("");
    // Test config is chainId 84532 → base-sepolia easscan host.
    expect(fb.feedbackURI).toBe(
      `https://base-sepolia.easscan.org/attestation/view/${ATTEST_UID}`,
    );
    // feedbackHash IS the attestation UID (immutable evidence binding).
    expect(fb.feedbackHash).toBe(ATTEST_UID);
    expect(gateway.mockChain.feedbackRevokes).toHaveLength(0);

    // Bookkeeping row: sent, with the 1-based index read via getLastIndex.
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("sent");
    });
    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row!.providerAgentId).toBe(PROVIDER_AGENT_ID);
    expect(row!.feedbackIndex).toBe(1n);
    expect(row!.attestationUid).toBe(ATTEST_UID);
    expect(row!.txHash).not.toBeNull();
  });

  it("does not allocate a feedback nonce outside the facilitator lock", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    const prepare = vi.spyOn(gateway.mockChain, "prepareFeedback");
    let lockEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    let releaseLock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const heldLock = gateway.bundle.queries.withFacilitatorTransactionLock(
      async (release) => {
        lockEntered();
        await blocked;
        await release();
      },
    );
    await entered;

    await gateway.bundle.reputationWorker.enqueue({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(prepare).not.toHaveBeenCalled();

    releaseLock();
    await heldLock;
    await vi.waitFor(() => {
      expect(prepare).toHaveBeenCalledOnce();
    });
  });

  it("NotConfirmed mirrors as value 0", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await postConfirm(gateway, { confirmation: "NotConfirmed" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(gateway.mockChain.feedbacks).toHaveLength(1);
    });
    expect(gateway.mockChain.feedbacks[0]!.value).toBe(0n);
    // No local challenge row seeded → tag2 falls back to "".
    expect(gateway.mockChain.feedbacks[0]!.tag2).toBe("");
  });

  it("mirror failure does not affect the confirmation response", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    // The spec's arms-length rule is the expected real-world failure.
    gateway.mockChain.queueFeedback({
      kind: "permanent",
      reason: "giveFeedback reverted: Self-feedback not allowed",
    });

    const res = await postConfirm(gateway, {});
    // Buyer's confirmation is untouched by the mirror failure.
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.attestationUid).toBe(ATTEST_UID);

    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("failed");
    });
    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row!.feedbackIndex).toBeNull();
    // One attempt was made; nothing was recorded as posted.
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
  });

  it("dead-letters a definitive receipt failure without retrying", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueFeedback({
      kind: "permanent",
      reason: "giveFeedback transaction succeeded without NewFeedback event",
    });

    await gateway.bundle.reputationWorker.enqueue({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });

    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("failed");
    });
    await gateway.bundle.reputationWorker.tick();

    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row?.attempts).toBe(1);
    expect(row?.giveFacilitatorTransactionId).toBeNull();
    const transaction =
      await gateway.bundle.queries.getFacilitatorTransaction({
        kind: "feedback_give",
        key: `${PAYMENT_ID}:${ATTEST_UID.toLowerCase()}`,
      });
    expect(transaction).toMatchObject({
      status: "reverted",
      preparedTransaction: null,
      failureCode: "feedback_give_reverted",
    });
    expect(row?.lastError).toBe("feedback_give_reverted");
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
  });

  it("retries transient RPC failures", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueFeedback({
      kind: "transient",
      reason: "RPC request timed out",
    });

    await gateway.bundle.reputationWorker.enqueue({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });

    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("retry");
    });
    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row?.attempts).toBe(1);
    expect(row?.giveFacilitatorTransactionId).not.toBeNull();
    const transaction =
      await gateway.bundle.queries.getFacilitatorTransactionById(
        row!.giveFacilitatorTransactionId!,
      );
    expect(transaction).toMatchObject({
      status: "prepared",
      transactionNonce: 0n,
      preparedTransaction: expect.any(String),
      broadcastAt: null,
    });
    expect(row?.lastError).toBe("reputation_transaction_failed");
    expect(row?.lastError).not.toContain("RPC request timed out");
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
  });

  it("finishes the exact prepared revision before promoting a replacement", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueFeedback({
      kind: "transient",
      reason: "RPC request timed out",
    });

    await gateway.bundle.reputationWorker.enqueue({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });
    await vi.waitFor(async () => {
      expect(
        (await gateway.bundle.queries.getReputationMirror(PAYMENT_ID))?.status,
      ).toBe("retry");
    });

    const prepared = await gateway.bundle.queries.getReputationMirror(
      PAYMENT_ID,
    );
    const transactionId = prepared!.giveFacilitatorTransactionId!;
    expect(
      await gateway.bundle.queries.enqueueReputationMirror({
        paymentId: PAYMENT_ID,
        confirmation: "NotConfirmed",
        attestationUid: REVISED_UID,
        refUid: null,
      }),
    ).toBe(false);
    const staged = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(staged).toMatchObject({
      attestationUid: ATTEST_UID,
      giveFacilitatorTransactionId: transactionId,
      pendingAttestationUid: REVISED_UID,
      pendingConfirmation: "NotConfirmed",
    });

    await gateway.bundle.pool.query(
      `UPDATE facilitator_transactions
          SET next_attempt_at = now()
        WHERE id = $1`,
      [transactionId],
    );
    await gateway.bundle.reputationWorker.tick();

    expect(gateway.mockChain.feedbacks.map((item) => item.feedbackHash)).toEqual([
      ATTEST_UID,
      ATTEST_UID,
      REVISED_UID,
    ]);
    expect(
      await gateway.bundle.queries.getFacilitatorTransactionById(transactionId),
    ).toMatchObject({
      status: "succeeded",
      failureCode: null,
    });
    expect(
      await gateway.bundle.queries.getReputationMirror(PAYMENT_ID),
    ).toMatchObject({
      status: "sent",
      attestationUid: REVISED_UID,
      pendingAttestationUid: null,
      giveFacilitatorTransactionId: null,
    });
  });

  it("terminalizes the journal and fails readiness on projection mismatch", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    vi.spyOn(
      gateway.bundle.queries,
      "finishReputationMirrorSuccess",
    ).mockRejectedValueOnce(new ReputationProjectionMismatchError());

    await gateway.bundle.reputationWorker.enqueue({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      const transaction = row?.giveFacilitatorTransactionId
        ? await gateway.bundle.queries.getFacilitatorTransactionById(
            row.giveFacilitatorTransactionId,
          )
        : null;
      expect(transaction).toMatchObject({
        status: "succeeded",
        failureCode: "reputation_projection_mismatch",
      });
    });

    expect(await new DatabaseReadinessProbe(gateway.bundle.pool, 0).isReady()).toBe(
      false,
    );
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
    await gateway.bundle.pool.query(
      `UPDATE reputation_mirrors
          SET updated_at = now() - interval '3 minutes'
        WHERE payment_id = $1`,
      [PAYMENT_ID.toString()],
    );
    await gateway.bundle.reputationWorker.tick();
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
  });

  it("dead-letters rows after the eight-claim attempt cap", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    await gateway.bundle.queries.enqueueReputationMirror({
      paymentId: PAYMENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      refUid: null,
    });
    await gateway.bundle.pool.query(
      `UPDATE reputation_mirrors
          SET status = 'retry', attempts = 8, next_attempt_at = now()
        WHERE payment_id = $1`,
      [PAYMENT_ID.toString()],
    );

    await gateway.bundle.reputationWorker.tick();

    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(8);
    expect(row?.lastError).toBe("reputation_submission_attempt_limit");
    expect(gateway.mockChain.feedbacks).toHaveLength(0);
  });

  it("returns a completed duplicate without posting second feedback", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600).toString();
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    await postConfirm(gateway, { deadline });
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("sent");
    });

    // An exact retry resolves from the durable completed transaction.
    const res = await postConfirm(gateway, { deadline });
    expect(res.status).toBe(200);
    expect(res.json.attestationUid).toBe(ATTEST_UID);

    // Nothing observable changes on the skip path — give the async mirror
    // a beat, then assert no second post happened.
    await new Promise((r) => setTimeout(r, 150));
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
    expect(gateway.mockChain.feedbackRevokes).toHaveLength(0);
  });

  it("revision (refUid) revokes the prior entry and posts fresh feedback", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    await postConfirm(gateway, { confirmation: "Confirmed" });
    await vi.waitFor(
      async () => {
        const row =
          await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
        expect(row?.feedbackIndex).toBe(1n);
      },
      { timeout: 5_000 },
    );
    gateway.mockChain.setReputationRecord(
      PAYMENT_ID,
      reputationRecord(ATTEST_UID),
    );

    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: REVISED_UID,
    });
    const res = await postConfirm(gateway, {
      confirmation: "NotConfirmed",
      refUid: ATTEST_UID,
      easNonce: "1",
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(gateway.mockChain.feedbacks).toHaveLength(2);
    });
    // Prior entry revoked by its stored index…
    expect(gateway.mockChain.feedbackRevokes).toEqual([
      { agentId: PROVIDER_AGENT_ID, feedbackIndex: 1n },
    ]);
    // …and the fresh post carries the revised confirmation + evidence.
    const revised = gateway.mockChain.feedbacks[1]!;
    expect(revised.value).toBe(0n);
    expect(revised.feedbackHash).toBe(REVISED_UID);

    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.feedbackIndex).toBe(2n);
    });
    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row!.status).toBe("sent");
    expect(row!.attestationUid).toBe(REVISED_UID);
  });

  it("revision still posts fresh feedback when the revoke reverts (already revoked)", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    await postConfirm(gateway, {});
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("sent");
    });
    gateway.mockChain.setReputationRecord(
      PAYMENT_ID,
      reputationRecord(ATTEST_UID),
    );

    gateway.mockChain.queueFeedbackRevoke({
      kind: "revert",
      reason: "already revoked",
    });
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: REVISED_UID,
    });
    await postConfirm(gateway, {
      confirmation: "NotConfirmed",
      refUid: ATTEST_UID,
      easNonce: "1",
    });

    // Revoke was attempted, swallowed, and the fresh post still landed.
    await vi.waitFor(() => {
      expect(gateway.mockChain.feedbacks).toHaveLength(2);
    });
    expect(gateway.mockChain.feedbackRevokes).toHaveLength(1);
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.attestationUid).toBe(REVISED_UID);
      expect(row?.status).toBe("sent");
    });
  });

  it("does not publish replacement feedback after an unclassified revoke failure", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    await postConfirm(gateway, {});
    await vi.waitFor(async () => {
      expect(
        (await gateway.bundle.queries.getReputationMirror(PAYMENT_ID))?.status,
      ).toBe("sent");
    });
    gateway.mockChain.setReputationRecord(
      PAYMENT_ID,
      reputationRecord(ATTEST_UID),
    );
    gateway.mockChain.queueFeedbackRevoke({
      kind: "revert",
      reason: "registry rejected revocation",
    });
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: `0x${"de".repeat(32)}` as Hex,
      attestationUid: REVISED_UID,
    });

    expect(
      (
        await postConfirm(gateway, {
          confirmation: "NotConfirmed",
          refUid: ATTEST_UID,
          easNonce: "1",
        })
      ).status,
    ).toBe(200);

    await vi.waitFor(async () => {
      expect(
        (await gateway.bundle.queries.getReputationMirror(PAYMENT_ID))?.status,
      ).toBe("failed");
    });
    expect(gateway.mockChain.feedbackRevokes).toHaveLength(1);
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
  });

  it("queues a retry when the authoritative router record is unavailable", async () => {
    await seedPaidChallenge(gateway, "domain-mgmt");
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    // Record present at confirm time (required for the resolver recipient),
    // gone by the time the mirror reads it — the retry scenario that can
    // still happen under the v0.6.0 recipient rule.
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );

    await postConfirm(gateway, {});
    gateway.mockChain.clearPaymentRecord(PAYMENT_ID);
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.status).toBe("retry");
    });
    expect(gateway.mockChain.feedbacks).toHaveLength(0);
  });

  it("records an ineligible payment as skipped", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID, false),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await postConfirm(gateway, {});
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.mockChain.feedbacks).toHaveLength(0);
    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row?.status).toBe("skipped");
  });

  it("supports canonical provider agent ID zero", async () => {
    gateway.mockChain.setPaymentRecord(PAYMENT_ID, paymentRecord(0n));
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await postConfirm(gateway, {});
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(gateway.mockChain.feedbacks).toHaveLength(1);
    });
    expect(gateway.mockChain.feedbacks[0]!.agentId).toBe(0n);
  });

});

describe("mirror disabled without REPUTATION_REGISTRY_ADDRESS", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    // Default test config leaves reputationRegistryAddress unset.
    gateway = await startTestGateway({
      providers: [
        {
          tokenId: PROVIDER_AGENT_ID,
          name: "Daski Test",
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

  it("confirmation succeeds and no feedback is posted", async () => {
    gateway.mockChain.setPaymentRecord(
      PAYMENT_ID,
      paymentRecord(PROVIDER_AGENT_ID),
    );
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });

    const res = await postConfirm(gateway, {});
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(gateway.mockChain.feedbacks).toHaveLength(0);
    expect(
      await gateway.bundle.queries.getReputationMirror(PAYMENT_ID),
    ).toBeNull();
  });
});
