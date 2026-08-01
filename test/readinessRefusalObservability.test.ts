import { encodePaymentSignatureHeader } from "@x402/core/http";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DASKI_X402_EXTENSION_URI } from "../src/config.js";
import { runBuyServiceX402Retry } from "../src/mcp/buyServiceRetry.js";
import { DaskiFacilitatorService } from "../src/payment/daskiFacilitator.js";
import { createQuotedChallenge } from "../src/payment/quotedChallenge.js";
import { hashCanonical } from "../src/payment/requirementResponse.js";
import {
  createPurchaseRouter,
  type PurchaseDeps,
} from "../src/payment/routes.js";
import type { PaymentPayload } from "../src/types.js";

// Every readiness-gate refusal of a payment operation must carry the
// probe's failedCheck (e.g. rpc_unavailable) to the caller — a silent
// refusal cost an hour of forensics on 2026-08-01 (see that day's
// deployment record). purchaseReadinessRefusal.test.ts pins the initial
// purchase; these pin the other sites: HTTP paid retry, MCP retry, the
// MCP quote path, and both facilitator gates. Wire codes stay STABLE
// (payment_screening_unready) for agents that match on them; the reason
// rides additively in message/details/body fields.
const unreadyProbe = {
  isReady: async () => false,
  status: () => ({ ready: false, failedCheck: "rpc_unavailable" }),
};

const ADDR = "0x1111111111111111111111111111111111111111";
const SERVICE_REF = `0x${"ab".repeat(32)}`;

function daskiPayload(): PaymentPayload {
  return {
    x402Version: 2,
    scheme: "daski-exact",
    network: "eip155:84532",
    payload: {},
    extensions: {
      [DASKI_X402_EXTENSION_URI]: {
        info: {
          profile: "1",
          x402Adapter: ADDR,
          paymentRouter: ADDR,
          serviceRef: SERVICE_REF,
          expectedPayee: ADDR,
        },
      },
    },
  } as unknown as PaymentPayload;
}

describe("readiness refusal observability", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("paid retry answers 503 with the probe's reason in the body", async () => {
    const body = {};
    const challenge = {
      providerTokenId: 2n,
      requestFingerprint: hashCanonical(body),
      settlementState: "pending",
    };
    const deps = {
      deploymentReadiness: unreadyProbe,
      queries: { getChallengeByRef: async () => challenge },
    } as unknown as PurchaseDeps;

    const app = express();
    app.use(express.json());
    app.use(createPurchaseRouter(deps));
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/purchase/2`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(daskiPayload()),
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.reason).toBe("rpc_unavailable");
    expect(json.retryable).toBe(true);
    expect(json.error).toBe(
      "Payment cannot be processed right now. Please try again later.",
    );
  });

  it("MCP retry keeps the stable code and carries the reason", async () => {
    const args = { walletAddress: ADDR, skillId: "s", serviceSlug: "slug" };
    const challenge = {
      requestFingerprint: hashCanonical(args),
      settlementState: "pending",
    };
    const result = await runBuyServiceX402Retry(
      args as never,
      { _meta: { "x402/payment": daskiPayload() } },
      {
        queries: { getChallengeByRef: async () => challenge },
        deploymentReadiness: unreadyProbe,
        facilitator: undefined,
      } as never,
    );
    expect(result?.isError).toBe(true);
    const payload = result?.structuredContent as Record<string, unknown>;
    expect(payload.code).toBe("payment_screening_unready");
    expect(payload.message).toContain("rpc_unavailable");
    expect((payload.details as Record<string, unknown>).reason).toBe(
      "rpc_unavailable",
    );
  });

  it("quote path keeps the stable code and carries the reason", async () => {
    const result = await createQuotedChallenge(
      {} as never,
      { deploymentReadiness: unreadyProbe } as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("payment_screening_unready");
    expect(result.error.message).toContain("rpc_unavailable");
    expect(result.error.details?.reason).toBe("rpc_unavailable");
  });

  function unreadyFacilitator(challenge: unknown) {
    return new DaskiFacilitatorService({
      config: {
        // Junk-but-valid test key (scalar 1); never used to sign here —
        // the readiness gate refuses before any signing.
        facilitatorPrivateKey: `0x${"00".repeat(31)}01`,
        x402Network: "eip155:84532",
      },
      queries: { getChallengeByRef: async () => challenge },
      reader: {},
      deploymentReadiness: unreadyProbe,
      providerAuthority: {},
    } as never);
  }

  it("facilitator verify keeps the stable code and carries the reason", async () => {
    const payload = daskiPayload();
    const requirements = {
      scheme: "daski-exact",
      network: "eip155:84532",
    } as never;
    (payload as { accepted?: unknown }).accepted = requirements;
    const challenge = { settlementState: "pending", paymentRequired: {} };
    const result = await unreadyFacilitator(challenge).verify(
      payload,
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("payment_screening_unready");
    expect(result.invalidMessage).toContain("rpc_unavailable");
  });

  it("facilitator settle keeps the stable code and carries the reason", async () => {
    const payload = daskiPayload();
    const requirements = {
      scheme: "daski-exact",
      network: "eip155:84532",
    } as never;
    (payload as { accepted?: unknown }).accepted = requirements;
    const challenge = { settlementState: "pending", paymentRequired: {} };
    const result = await unreadyFacilitator(challenge).settleDetailed(
      payload,
      requirements,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a settlement failure");
    expect(result.status).toBe(503);
    expect(result.failure.code).toBe("payment_screening_unready");
    expect(result.failure.message).toContain("rpc_unavailable");
    expect(result.response.retryable).toBe(true);
  });
});
