import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestGateway, type TestGateway } from "./helpers/setup.js";
import type { Hex } from "../src/types.js";

const BUYER = "0xbbbb000000000000000000000000000000000001" as Hex;
const TX_HASH =
  "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex;
const ATTEST_UID =
  "0xcafe000000000000000000000000000000000000000000000000000000000001" as Hex;

const SIG = {
  v: 27,
  r: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
  s: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
};

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
      cachedProviderWallet: "0x000000000000000000000000000000000000c002" as Hex,
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
      body: JSON.stringify({
        confirmation: "Confirmed",
        attester: BUYER,
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        signature: SIG,
      }),
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

    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "NotConfirmed",
        attester: BUYER,
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        refUid: priorUid,
        signature: SIG,
      }),
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
        signature: SIG,
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
        deadline: "0",
        signature: SIG,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the chain reader throws", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "revert",
      reason: "attestByDelegation reverted: bad signature",
    });

    const res = await fetch(`${gateway.baseUrl}/confirm/42`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "Confirmed",
        attester: BUYER,
        // Future deadline so the input passes validation and the
        // confirm path reaches the (mocked) chain submit. The chain
        // mock returns the configured revert; the response must expose a
        // reference without reflecting the upstream chain error.
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        signature: SIG,
      }),
    });
    expect(res.status).toBe(400);
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
      body: JSON.stringify({
        confirmation: "Confirmed",
        attester: BUYER,
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        signature: SIG,
      }),
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
    expect(body.error.details.signatureConsumed).toBe("no");
    expect(body.error.message).toContain("NOT");
  });

  it("tells a deadline/nonce revert to re-sign instead of retrying", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "validation",
      reason: "EAS.attestByDelegation reverted: DeadlineExpired()",
      needsFreshSignature: true,
    });
    const { body } = await postConfirm();
    expect(body.error.code).toBe("submit_rejected");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.requiresFreshSignature).toBe(true);
    expect(body.error.message).toContain("prepareConfirmation");
  });

  it("refuses to call a post-broadcast failure retryable", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "unknown",
      reason: "receipt unavailable",
      txHash: `0x${"ab".repeat(32)}` as `0x${string}`,
    });
    const { status, body } = await postConfirm();
    expect(status).toBe(502);
    expect(body.error.code).toBe("submit_outcome_unknown");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.signatureConsumed).toBe("unknown");
  });

  it("surfaces an attested-but-unrecorded confirmation as its own failure", async () => {
    gateway.mockChain.queueConfirmation({
      kind: "stage",
      stage: "attestation",
      reason: "Attested event not found",
      txHash: `0x${"cd".repeat(32)}` as `0x${string}`,
    });
    const { status, body } = await postConfirm();
    expect(status).toBe(500);
    expect(body.error.code).toBe("attestation_unrecorded");
    expect(body.error.retryable).toBe(false);
    expect(body.error.details.signatureConsumed).toBe("yes");
    expect(body.error.details.transactionHash).toBe(`0x${"cd".repeat(32)}`);
  });
});
