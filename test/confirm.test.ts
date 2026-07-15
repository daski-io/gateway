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
        // mock returns the configured revert; we assert the error
        // surfaces as `submit_failed` with the chain's reason.
        deadline: String(Math.floor(Date.now() / 1000) + 3600),
        signature: SIG,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("submit_failed");
    expect(body.error.message).toContain("bad signature");
  });
});
