import { createHash, randomUUID } from "node:crypto";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailIncidentStore } from "../src/standardRail/incidents.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { createPayerSignatureVerifier } from "../src/standardRail/payerSignature.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { StandardRailStore } from "../src/standardRail/store.js";

/// A payer-signed order action consumes its authorization before the gateway
/// calls the provider, so a refusal or an unavailable provider leaves that
/// nonce spent: the same authorization never reaches the provider again, and
/// the buyer retries with a fresh one. The retry forwards the original request
/// unchanged, support requestId included, so the provider's own deduplication
/// keeps one support message however many attempts carry it.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const providerAuthority = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ORDER_ID = "ord_12345678-1234-4123-8123-123456789abc";
const HANDLE = "handle-lifecycle-retry";
const TASK_ID = "task-lifecycle-retry";
const REVIEW_ID = "8d42e3f9-1111-4222-8333-944455556666";
const LIFECYCLE_URL = "https://provider.example/standard-rail/lifecycle";

interface LifecycleBody {
  request: { requestId: string; message: string };
  authorization: { nonce: Hex };
  grant: { payload: { requestHash: Hex; authorizationHash: Hex } };
}
type Authorization = Record<string, unknown> & { nonce: Hex; signature: Hex };

const schema = `lifecycle_retry_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 6 });
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

beforeEach(async () => {
  for (const table of ["standard_security_incidents", "standard_action_nonces", "standard_action_challenges",
    "standard_order_operations", "standard_orders"]) await pool.query(`DELETE FROM ${table}`);
  const bytes = Buffer.alloc(32, 1);
  const listing = {
    commitment: { payload: {
      providerAuthorityKey: providerAuthority.address, providerTerminalAttestationKey: providerAuthority.address,
    } },
    providerControlProfile: { payload: {
      providerAudience: "https://provider.example", lifecycleUrl: LIFECYCLE_URL,
      timeoutMs: 3_000, maxResponseBytes: 65_536,
    } },
  };
  await pool.query(`INSERT INTO standard_orders (
    order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
    canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at,payer,provider_task_id)
    VALUES ($1,$2,$3,$4,'DISPATCHED','7','audit','recipe-bound-v2',$2,$2,$5,$2,'{}',$2,'{}',$2,
      'int_12345678-1234-4123-8123-123456789abc',1000000,1,1,now(),$6,$7)`,
  [ORDER_ID, bytes, HANDLE, createHash("sha256").update(HANDLE).digest(), listing, payer.address, TASK_ID]);
});

/** A provider support desk that deduplicates by requestId, as provider-full does. */
function supportDesk() {
  const accepted = new Map<string, { messageId: string; message: string; acceptedAt: number }>();
  const desk = { available: false, accepted, calls: [] as LifecycleBody[] };
  const fetch = vi.fn(async (_listing: unknown, url: string, init: RequestInit) => {
    expect(url).toBe(LIFECYCLE_URL);
    const body = JSON.parse(String(init.body)) as LifecycleBody;
    desk.calls.push(body);
    if (!desk.available) return Response.json({ error: "lifecycle_unavailable" }, { status: 503 });
    const { requestId, message } = body.request;
    let receipt = accepted.get(requestId);
    if (receipt && receipt.message !== message) return Response.json({ error: "action_conflict" }, { status: 409 });
    if (!receipt) {
      receipt = { messageId: randomUUID(), message, acceptedAt: Math.floor(Date.now() / 1_000) - 1 };
      accepted.set(requestId, receipt);
    }
    const payload = {
      orderId: ORDER_ID, taskId: TASK_ID, state: "working",
      operations: { schemaVersion: 1, revision: 1, observedAt: Math.floor(Date.now() / 1_000), fulfillment: null,
        support: { reviewId: REVIEW_ID, status: "open",
          lastAcceptedRequest: { requestId, messageId: receipt.messageId, acceptedAt: receipt.acceptedAt } },
        recovery: null },
      result: { supportReceipt: { requestId, messageId: receipt.messageId, reviewId: REVIEW_ID,
        acceptedAt: new Date(receipt.acceptedAt * 1_000).toISOString() } },
    };
    return Response.json({ ...payload,
      signature: await providerAuthority.signMessage({ message: { raw: canonicalHash(payload) } }) });
  });
  return { desk, fetch };
}

function gateway(providerFetch: ReturnType<typeof supportDesk>["fetch"]) {
  return Object.assign(Object.create(StandardRailService.prototype), {
    appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
    railConfig: {
      gatewayAudience: "https://gateway.example", encryptionKey: Buffer.alloc(32, 7), environment: "testnet",
      signers: localGatewaySigners(`0x${"33".repeat(32)}`), dispatchTimeoutMs: 3_000,
      abuse: { walletChallengesOutstandingGlobal: 1_000, assetStateChangesPerPayerPerMinute: 1_000 },
    },
    assertRailFence: async () => undefined,
    store: new StandardRailStore(pool),
    journal: new StandardRailJournal(pool),
    incidents: new StandardRailIncidentStore(pool),
    payerSignature: createPayerSignatureVerifier({ accountTypes: ["eoa"], timeoutMs: 0, endpoints: [] }),
    providerFetch,
    signedReceipt: async () => null,
    confirmationState: { stored: async () => null },
    submissionStatus: async () => null,
  }) as StandardRailService;
}

async function authorize(service: StandardRailService, request: Record<string, unknown>): Promise<Authorization> {
  const { signRequest, ...challenge } = await service.issueActionChallenge({
    handle: HANDLE, action: "support", request, clientKey: "203.0.113.7",
  }) as Record<string, unknown> & { signRequest: Parameters<typeof payer.signTypedData>[0] };
  return { ...challenge, signature: await payer.signTypedData(signRequest) } as Authorization;
}

const support = (service: StandardRailService, request: Record<string, unknown>, authorization: Authorization) =>
  service.performAction({ handle: HANDLE, action: "support", request, authorization: authorization as never });

async function nonceSpent(nonce: Hex): Promise<boolean> {
  const challenge = await pool.query("SELECT consumed_at FROM standard_action_challenges WHERE nonce=$1",
    [Buffer.from(nonce.slice(2), "hex")]);
  const spent = await pool.query("SELECT 1 FROM standard_action_nonces WHERE nonce=$1", [Buffer.from(nonce.slice(2), "hex")]);
  return challenge.rows[0]?.consumed_at instanceof Date && spent.rowCount === 1;
}

describe("lifecycle retry after a provider refusal (postgres)", () => {
  it("never replays a consumed nonce and forwards the retried support request unchanged", async () => {
    const { desk, fetch } = supportDesk();
    const service = gateway(fetch);
    const request = { requestId: "support-1", message: "Where is my report?" };

    const first = await authorize(service, request);
    await expect(support(service, request, first)).rejects.toMatchObject({
      code: "PROVIDER_LIFECYCLE_UNAVAILABLE", status: 503, retryable: true, requiresNewSignature: true,
    });
    expect(desk.calls).toHaveLength(1);
    // The authorization was spent before the provider answered; nothing restores it.
    expect(await nonceSpent(first.nonce)).toBe(true);
    expect((await pool.query("SELECT capability_epoch FROM standard_orders")).rows[0].capability_epoch).toBe("0");

    desk.available = true;
    await expect(support(service, request, first)).rejects.toMatchObject({ code: "WALLET_AUTHORIZATION_INVALID" });
    expect(desk.calls).toHaveLength(1);
    expect((await pool.query("SELECT incident_kind FROM standard_security_incidents")).rows)
      .toEqual([{ incident_kind: "action_authorization_reuse_or_tamper" }]);

    const second = await authorize(service, request);
    const answer = await support(service, request, second) as { result: { supportReceipt: Record<string, unknown> } };
    expect(answer.result.supportReceipt).toMatchObject({ requestId: "support-1", reviewId: REVIEW_ID });
    expect(desk.calls).toHaveLength(2);
    expect(desk.calls[1]!.request).toEqual(request);
    expect(desk.calls[1]!.request).toEqual(desk.calls[0]!.request);
    expect(desk.calls[1]!.grant.payload.requestHash).toBe(desk.calls[0]!.grant.payload.requestHash);
    expect(desk.calls[1]!.authorization.nonce).not.toBe(desk.calls[0]!.authorization.nonce);
    expect(desk.calls[1]!.grant.payload.authorizationHash).not.toBe(desk.calls[0]!.grant.payload.authorizationHash);

    // A lost answer is retried the same way and still yields the one message.
    const third = await authorize(service, request);
    const again = await support(service, request, third) as { result: { supportReceipt: Record<string, unknown> } };
    expect(again.result.supportReceipt).toEqual(answer.result.supportReceipt);
    expect(desk.accepted.size).toBe(1);
    expect(desk.calls).toHaveLength(3);
    await expect(support(service, request, second)).rejects.toMatchObject({ code: "WALLET_AUTHORIZATION_INVALID" });
    expect(desk.calls).toHaveLength(3);
  }, 60_000);

  it("names a reused requestId with different content and keeps the original message", async () => {
    const { desk, fetch } = supportDesk();
    desk.available = true;
    const service = gateway(fetch);
    const original = { requestId: "support-2", message: "Please resend the report." };
    await support(service, original, await authorize(service, original));
    const changed = { requestId: "support-2", message: "Cancel my order instead." };
    const conflicting = await authorize(service, changed);
    await expect(support(service, changed, conflicting)).rejects.toMatchObject({
      code: "ORDER_ACTION_CONFLICT", status: 409, retryable: false,
    });
    expect(await nonceSpent(conflicting.nonce)).toBe(true);
    expect([...desk.accepted.values()].map((receipt) => receipt.message)).toEqual([original.message]);
  }, 60_000);
});
