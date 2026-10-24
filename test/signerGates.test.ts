import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base } from "viem/chains";
import { getAddress, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { asStandardRailError } from "../src/standardRail/errors.js";
import { getIntakeRequirements } from "../src/standardRail/intake.js";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { localGatewaySigners, SignerRefused, SignerUnavailable } from "../src/standardRail/signer.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";
import { logger } from "../src/util/logger.js";

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const payer = getAddress(`0x${"22".repeat(20)}`);
let server: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

async function serve(app: express.Express) {
  server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return `http://127.0.0.1:${address.port}`;
}

interface Harness {
  issueChallenge: StandardRailService["issueChallenge"];
  settleClaimedOrder(args: Record<string, unknown>): Promise<StandardOrderRecord>;
  resumePreSettlement(order: StandardOrderRecord, listing: StandardListing): Promise<StandardOrderRecord>;
}

function harness(fields: Record<string, unknown>): Harness {
  return Object.assign(Object.create(StandardRailService.prototype), {
    releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
    salesOutage: { assertOpen: async () => undefined, status: async () => ({ salesOpen: true }) },
    signerHealth: () => false,
    ...fields,
  }) as unknown as Harness;
}

const listing = {
  registrationId: "reg-1",
  requestSchema: { type: "object", properties: {}, additionalProperties: false },
  purchaseReadiness: null,
  commitment: { payload: { canonicalToken: `0x${"33".repeat(20)}`, outcomeId: "outcome" } },
  deadlinePolicy: { settlementEvidenceSeconds: 900, releaseEvidenceSeconds: 900 },
} as unknown as StandardListing;

describe("an unhealthy signer stops new sales like an outage", () => {
  it("refuses a challenge before quoting anything", async () => {
    const quote = vi.fn();
    const service = harness({ assertAdmissionOpen: vi.fn(), assertRailFence: vi.fn(async () => undefined), listing: quote });
    await expect(service.issueChallenge({ providerAgentId: "7", outcomeId: "outcome", body: {} })).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE", status: 503, phase: "challenge", retryable: true, retryAfterSeconds: 30,
      requiresNewSignature: false, paymentMayHaveSettled: false,
    });
    expect(quote).not.toHaveBeenCalled();
  });

  it("refuses to submit a claimed authorization and says it may still settle", async () => {
    const markSettleInvoked = vi.fn(async () => true);
    const service = harness({
      appConfig: { publicUrl: "https://gateway.example", chainId: 84532, x402Network: "eip155:84532" },
      railConfig: { manifest: { activeRailProfile: { payload: {} } } },
      store: {
        transition: vi.fn(async (order: StandardOrderRecord, to: string) => ({ ...order, state: to })),
        releaseCapacity: vi.fn(), listingSettlementFrozen: vi.fn(async () => false),
      },
      journal: { markVerifyInvoked: vi.fn(), recordVerify: vi.fn(), markSettleInvoked },
      facilitator: { verify: vi.fn(async () => ({ isValid: true, payer })) },
      screenParticipants: vi.fn(async () => undefined),
      verifyListingIdentity: vi.fn(async () => undefined),
      withRailFence: (work: () => Promise<unknown>) => work(),
      evidence: { authorizationUsed: vi.fn(async () => false) },
    });
    const error = await service.settleClaimedOrder({
      order: { orderId: "ord_1", payer, listing, state: "ATTEMPT_OPENED" }, listing,
      requirements: {} as PaymentRequirements, authorization: { payer, nonce: hash("6") }, body: {},
      payment: {} as PaymentPayload,
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "SIGNER_UNAVAILABLE", phase: "facilitator_settle", requiresNewSignature: false,
      paymentMayHaveSettled: true });
    expect(markSettleInvoked).not.toHaveBeenCalled();
  });

  it("leaves a claimed authorization unsubmitted in recovery", async () => {
    const order = { orderId: "ord_1", payer, state: "VERIFIED", listing, encryptedPaymentPayload: Buffer.from("x"),
      paymentPayloadHash: hash("a") } as unknown as StandardOrderRecord;
    const verify = vi.fn();
    const service = harness({
      storedPayment: vi.fn(() => ({})),
      paymentAuthorizationValidBefore: vi.fn(() => Math.floor(Date.now() / 1_000) + 600),
      facilitator: { verify },
      journal: { markSettleInvoked: vi.fn() },
    });
    await expect(service.resumePreSettlement(order, listing)).resolves.toBe(order);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("signer errors on the wire", () => {
  it("answer SignerUnavailable as a retryable 503 and SignerRefused as an internal error", () => {
    expect(asStandardRailError(new SignerUnavailable("identity", "personal_sign"))).toMatchObject({
      code: "SIGNER_UNAVAILABLE", status: 503, retryable: true, paymentMayHaveSettled: false, retryAfterSeconds: 30,
    });
    expect(asStandardRailError(new SignerRefused("identity", "personal_sign", "HTTP_403"))).toMatchObject({
      code: "INTERNAL_ERROR", status: 500, retryable: false,
    });
  });

  it("never blame the provider for intake when the gateway cannot sign", async () => {
    const account = { signMessage: vi.fn(async () => { throw new SignerUnavailable("identity", "personal_sign"); }) };
    const fetchProvider = vi.fn();
    await expect(getIntakeRequirements({
      listing: { providerControlProfile: { payload: { providerAudience: "https://provider.example" } },
        commitment: { payload: { outcomeId: "outcome" } }, runtimeCommitmentHash: hash("1") } as never,
      request: {}, environment: "testnet", chainId: 84532, account: account as never, timeoutMs: 1_000, fetchProvider,
    })).rejects.toBeInstanceOf(SignerUnavailable);
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it("answer a paid purchase 202 when its receipt cannot be signed yet", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const order = { orderId: "ord_1", state: "DISPATCHED" };
    const service = {
      submitPayment: vi.fn(async () => ({ handle: "handle-1", order, replay: false })),
      purchaseReceipts: vi.fn(async () => { throw new SignerUnavailable("identity", "personal_sign"); }),
      submissionStatus: vi.fn(async () => null),
    };
    const app = express();
    app.use(express.json());
    app.use(createStandardRailRouter(service as never, "https://gateway.example"));
    const url = await serve(app);
    const response = await fetch(`${url}/outcomes/7/outcome/purchase`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ request: {}, paymentPayload: { x402Version: 2 } }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ orderHandle: "handle-1", state: "DISPATCHED", receipt: null });
  });
});

describe("the reputation relayer during a signer outage", () => {
  it("defers an operation without spending one of its attempts", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM standard_reputation_operations") && sql.includes("kind=$1")
        ? [{ operation_id: "op", kind: "register", state: "pending", attempts: 2 }] : [],
      rowCount: 1,
    }));
    const worker = new StandardReputationWorker({ query } as never, {
      signers: localGatewaySigners(`0x${"22".repeat(32)}`), evidenceRpcUrls: ["https://rpc.example"],
      reputationRetryDelaysSeconds: [5, 60, 3_000, 30_000],
    } as never, base);
    Object.assign(worker, {
      reconcileFinalizedConfirmations: async () => undefined,
      reconcileParkedReviews: async () => undefined,
      process: async () => { throw new SignerUnavailable("sender", "eth_signTransaction"); },
    });
    await (worker as unknown as { runBatch(): Promise<void> }).runBatch();
    const writes = query.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("UPDATE standard_reputation_operations"));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((sql) => sql.includes("interval '30 seconds'") && !sql.includes("attempts="))).toBe(true);
  });
});

describe("readiness", () => {
  it("reports each role and fails while a signer is unhealthy, with addresses only for the operator", async () => {
    const token = "signer-readiness-token-0123456789abcdef";
    let healthy = true;
    const statuses = () => [
      { role: "identity", backend: "privy", address: payer, status: healthy ? "healthy" : "unhealthy",
        ...(healthy ? {} : { reason: "signature_refused" }), refusals: healthy ? 0 : 1 },
      { role: "sender", backend: "privy", address: payer, status: "healthy", refusals: 0 },
    ];
    const app = express();
    app.use(createStandardMetaRouter({ config: { catalogOperatorToken: token, x402Network: "eip155:84532", chainId: 84532 } as never,
      pool: { query: async () => ({ rows: [] }) } as never, lifecycle: { isStopping: () => false } as never, railConfig: {} as never,
      service: { signerStatuses: statuses, isAdmissionOpen: () => true, areDependenciesReady: () => true,
        operationalHealth: async () => ({}), railProfileHash: hash("a"),
        salesOutage: { publicStatus: async () => ({ salesOpen: true }), operatorState: async () => ({ salesOpen: true, revision: 0 }) } } as never }));
    const url = await serve(app);
    const ready = await fetch(`${url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ dependencies: { signers: "ready" },
      signers: [{ role: "identity", backend: "privy", status: "healthy" }, { role: "sender", backend: "privy", status: "healthy" }] });
    healthy = false;
    const unready = await fetch(`${url}/health/ready`);
    expect(unready.status).toBe(503);
    const body = await unready.json() as { dependencies: { signers: string }; signers: Array<Record<string, unknown>> };
    expect(body.dependencies.signers).toBe("unready");
    expect(body.signers[0]).toEqual({ role: "identity", backend: "privy", status: "unhealthy" });
    const operator = await fetch(`${url}/health/ready`, { headers: { authorization: `Bearer ${token}` } });
    expect((await operator.json() as { signers: unknown[] }).signers[0])
      .toEqual({ role: "identity", backend: "privy", address: payer, status: "unhealthy", reason: "signature_refused", refusals: 1 });
  });
});
