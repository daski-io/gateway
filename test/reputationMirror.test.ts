import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";
import { buildFeedbackInput } from "../src/reputation/mirror.js";

// Canonical-feedback mirror (src/reputation/mirror.ts). The mirror is
// fire-and-forget from POST /confirm — these tests await its side effects
// (mock reader call records + the reputation_mirrors row) via vi.waitFor
// rather than the HTTP response.

const BUYER = "0xbbbb000000000000000000000000000000000001" as Hex;
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

const SIG = {
  v: 27,
  r: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
  s: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
};

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
    cachedProviderWallet:
      "0x000000000000000000000000000000000000c002" as Hex,
    serviceRef: ("0x" + "ab".repeat(32)) as Hex,
    paidAt: BigInt(Math.floor(Date.now() / 1000)),
    reputationEligible,
  };
}

async function postConfirm(
  gateway: TestGateway,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${gateway.baseUrl}/confirm/${PAYMENT_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmation: "Confirmed",
      attester: BUYER,
      deadline: String(Math.floor(Date.now() / 1000) + 3600),
      signature: SIG,
      ...body,
    }),
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
      kind: "revert",
      reason: "giveFeedback reverted: owner cannot self-review",
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

  it("duplicate confirmation (no refUid) does not post a second feedback", async () => {
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

    // Retry of the same confirmation (mock EAS accepts; in prod the
    // resolver rejects refUID-less duplicates — the mirror's own dedupe
    // is what's under test here).
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: ATTEST_UID,
    });
    const res = await postConfirm(gateway, {});
    expect(res.status).toBe(200);

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
    await vi.waitFor(async () => {
      const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
      expect(row?.feedbackIndex).toBe(1n);
    });

    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: REVISED_UID,
    });
    const res = await postConfirm(gateway, {
      confirmation: "NotConfirmed",
      refUid: ATTEST_UID,
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

    gateway.mockChain.queueFeedbackRevoke({
      kind: "revert",
      reason: "revokeFeedback reverted: already revoked",
    });
    gateway.mockChain.queueConfirmation({
      kind: "success",
      txHash: TX_HASH,
      attestationUid: REVISED_UID,
    });
    await postConfirm(gateway, {
      confirmation: "NotConfirmed",
      refUid: ATTEST_UID,
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

  it("rebroadcasts the identical prepared transaction after a worker crash", async () => {
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
    await gateway.bundle.queries.claimReputationMirror(PAYMENT_ID);
    const feedback = buildFeedbackInput({
      config: gateway.config,
      providerAgentId: PROVIDER_AGENT_ID,
      confirmation: "Confirmed",
      attestationUid: ATTEST_UID,
      serviceSlug: "",
    });
    const prepared = await gateway.mockChain.prepareFeedback(feedback);
    await gateway.bundle.queries.markReputationMirrorPrepared({
      paymentId: PAYMENT_ID,
      transactionHash: prepared.transactionHash,
      preparedTransaction: prepared.serializedTransaction,
      transactionNonce: prepared.nonce,
    });

    await gateway.bundle.reputationWorker.tick();

    const row = await gateway.bundle.queries.getReputationMirror(PAYMENT_ID);
    expect(row?.status).toBe("sent");
    expect(row?.txHash).toBe(prepared.transactionHash);
    expect(gateway.mockChain.feedbacks).toHaveLength(1);
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
