import { createHash, randomUUID } from "node:crypto";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { StandardRailIncidentStore } from "../src/standardRail/incidents.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { createPayerSignatureVerifier } from "../src/standardRail/payerSignature.js";
import { StandardProviderDispatch } from "../src/standardRail/providerDispatch.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { StandardRailStore } from "../src/standardRail/store.js";

/// An order action reads the order, waits on the provider, then applies what
/// the provider reported to the copy it read. It holds no lease, so recovery
/// or a second request can move the order, or just its lease fence, during
/// that wait (2026-10-30: one sandbox status request answered 500 for this
/// during paid acceptance). The provider's evidence is stored by then and the
/// order is carried on either way, so the request answers with the order as
/// the database holds it now.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const payer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const providerAuthority = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ORDER_ID = "ord_12345678-1234-4123-8123-123456789abc";
const HANDLE = "handle-action-conflict";
const TASK_ID = "task-action-conflict";
const LIFECYCLE_URL = "https://provider.example/standard-rail/lifecycle";
const DISPATCH_STATUS_URL = "https://provider.example/standard-rail/dispatch-status";
const DISPATCH_HASH = `0x${"cd".repeat(32)}` as const;
// A provider's terminal identity is fixed, so every answer carries the same one.
const NOW = Math.floor(Date.now() / 1_000);
const RESULT_HASH = `0x${"ab".repeat(32)}`;
const OPERATIONS = { schemaVersion: 1, revision: 1, observedAt: NOW, fulfillment: null, support: null, recovery: null };

const schema = `action_conflict_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;
let store: StandardRailStore;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 6 });
  await runMigrations(pool);
  store = new StandardRailStore(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

beforeEach(async () => {
  for (const table of ["standard_security_incidents", "standard_action_nonces", "standard_action_challenges",
    "standard_order_operations", "standard_order_transitions", "standard_orders"]) await pool.query(`DELETE FROM ${table}`);
  const bytes = Buffer.alloc(32, 1);
  const listing = {
    commitment: { payload: {
      providerAuthorityKey: providerAuthority.address, providerTerminalAttestationKey: providerAuthority.address,
    } },
    providerControlProfile: { payload: {
      providerAudience: "https://provider.example", lifecycleUrl: LIFECYCLE_URL,
      dispatchStatusUrl: DISPATCH_STATUS_URL,
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

const signed = (value: unknown) => providerAuthority.signMessage({ message: { raw: canonicalHash(value) } });

/** A provider answering every lifecycle action with `state`, signed, after `during` runs. */
function lifecycleProvider(state: "working" | "completed", during: () => Promise<void> = async () => undefined) {
  return vi.fn(async (_listing: unknown, url: string) => {
    expect(url).toBe(LIFECYCLE_URL);
    await during();
    const payload = { orderId: ORDER_ID, taskId: TASK_ID, state, resultHash: RESULT_HASH, completedAt: NOW };
    const body = {
      orderId: ORDER_ID, taskId: TASK_ID, state, operations: OPERATIONS,
      ...(state === "completed" ? { terminalAttestation: { payload, signature: await signed(payload) } } : {}),
    };
    return Response.json({ ...body, signature: await signed(body) });
  });
}

const completedProvider = (during?: () => Promise<void>) => lifecycleProvider("completed", during);

/** The recovery worker's dispatcher, against a provider reporting the same terminal state. */
function recoveryDispatcher() {
  const providerFetch = vi.fn(async (_listing: unknown, url: string) => {
    expect(url).toBe(DISPATCH_STATUS_URL);
    const payload = { taskId: TASK_ID, dispatchHash: DISPATCH_HASH, state: "completed", resultHash: RESULT_HASH, completedAt: NOW };
    const body = { taskId: TASK_ID, dispatchHash: DISPATCH_HASH, state: "completed", operations: OPERATIONS };
    return Response.json({ ...body, signature: await signed(body),
      terminalAttestation: { payload, signature: await signed(payload) } });
  });
  return Object.assign(Object.create(StandardProviderDispatch.prototype), {
    appConfig: { chainId: 84532 },
    railConfig: {
      environment: "testnet", signers: localGatewaySigners(`0x${"33".repeat(32)}`), dispatchTimeoutMs: 3_000,
    },
    journal: { resolveDispatch: async () => undefined },
    store,
    providerFetch,
  }) as StandardProviderDispatch;
}

function gateway(providerFetch: ReturnType<typeof lifecycleProvider>) {
  return Object.assign(Object.create(StandardRailService.prototype), {
    appConfig: { chainId: 84532, publicUrl: "https://gateway.example" },
    railConfig: {
      gatewayAudience: "https://gateway.example", encryptionKey: Buffer.alloc(32, 7), environment: "testnet",
      signers: localGatewaySigners(`0x${"33".repeat(32)}`), dispatchTimeoutMs: 3_000,
      abuse: { walletChallengesOutstandingGlobal: 1_000, assetStateChangesPerPayerPerMinute: 1_000 },
    },
    assertRailFence: async () => undefined,
    store,
    journal: new StandardRailJournal(pool),
    incidents: new StandardRailIncidentStore(pool),
    payerSignature: createPayerSignatureVerifier({ accountTypes: ["eoa"], timeoutMs: 0, endpoints: [] }),
    providerFetch,
    signedReceipt: async () => null,
    confirmationState: { stored: async () => null },
    submissionStatus: async () => null,
  }) as StandardRailService;
}

async function act(service: StandardRailService, action: "status" | "input"): Promise<Record<string, unknown>> {
  const request = {};
  const { signRequest, ...challenge } = await service.issueActionChallenge({
    handle: HANDLE, action, request, clientKey: "203.0.113.7",
  }) as Record<string, unknown> & { signRequest: Parameters<typeof payer.signTypedData>[0] };
  const authorization = { ...challenge, signature: await payer.signTypedData(signRequest) };
  return await service.performAction({
    handle: HANDLE, action, request, authorization: authorization as never,
  }) as Record<string, unknown>;
}

const status = (service: StandardRailService) => act(service, "status");

async function current() {
  const order = await store.findById(ORDER_ID);
  if (!order) throw new Error("the test order is missing");
  return order;
}

async function fulfilledTransitions(): Promise<number> {
  const rows = await pool.query("SELECT 1 FROM standard_order_transitions WHERE to_state='FULFILLED'");
  return rows.rowCount ?? 0;
}

async function incidentCount(): Promise<number> {
  return (await pool.query("SELECT 1 FROM standard_security_incidents")).rowCount ?? 0;
}

async function storedTerminal(): Promise<unknown> {
  const rows = await pool.query("SELECT original_terminal FROM standard_order_operations WHERE order_id=$1", [ORDER_ID]);
  return rows.rows[0]?.original_terminal ?? null;
}

describe("order action fenced out of its transition (postgres)", () => {
  it("answers with the unchanged order when recovery leased it during the provider call", async () => {
    const service = gateway(completedProvider(async () => {
      await store.leaseOrder(ORDER_ID, "standard-recovery-worker", 45);
    }));

    const answer = await status(service);

    expect(answer).toMatchObject({ orderHandle: HANDLE, state: "completed", orderState: "DISPATCHED", fulfillmentState: "completed" });
    expect((await current()).state).toBe("DISPATCHED");
    expect(await storedTerminal()).not.toBeNull();
    expect(await incidentCount()).toBe(0);
  }, 60_000);

  it("lets recovery apply the provider's state after a fenced-out status", async () => {
    const service = gateway(completedProvider(async () => {
      await store.leaseOrder(ORDER_ID, "standard-recovery-worker", 45);
    }));
    await status(service);

    const recovered = await recoveryDispatcher().reconcile(await current(), (await current()).listing, DISPATCH_HASH);

    expect(recovered.state).toBe("FULFILLED");
    expect(await fulfilledTransitions()).toBe(1);
  }, 60_000);

  it("lets the next status apply the provider's state", async () => {
    let leased = false;
    const service = gateway(completedProvider(async () => {
      if (leased) return;
      leased = true;
      await store.leaseOrder(ORDER_ID, "standard-recovery-worker", 45);
    }));

    await status(service);
    const answer = await status(service);

    expect(answer).toMatchObject({ orderState: "FULFILLED" });
    expect(await fulfilledTransitions()).toBe(1);
  }, 60_000);

  it("answers with the state recovery reached during the provider call", async () => {
    const service = gateway(completedProvider(async () => {
      await store.transition(await current(), "FULFILLED", "provider_terminal_completed");
    }));

    const answer = await status(service);

    expect(answer).toMatchObject({ state: "completed", orderState: "FULFILLED" });
    expect(await fulfilledTransitions()).toBe(1);
    expect(await incidentCount()).toBe(0);
  }, 60_000);

  it("gives two racing status requests the same fulfilled order and one transition", async () => {
    let arrived = 0;
    let bothInProvider!: () => void;
    const barrier = new Promise<void>((resolve) => { bothInProvider = resolve; });
    const service = gateway(completedProvider(async () => {
      arrived += 1;
      if (arrived === 2) bothInProvider();
      await barrier;
    }));

    const answers = await Promise.all([status(service), status(service)]);

    for (const answer of answers) expect(answer).toMatchObject({ state: "completed", orderState: "FULFILLED" });
    expect(await fulfilledTransitions()).toBe(1);
    expect(await incidentCount()).toBe(0);
  }, 60_000);

  it("still moves the capability epoch when a fenced-out input took effect at the provider", async () => {
    await pool.query("UPDATE standard_orders SET state='INPUT_REQUIRED'");
    const service = gateway(lifecycleProvider("working", async () => {
      await store.leaseOrder(ORDER_ID, "standard-recovery-worker", 45);
    }));

    const answer = await act(service, "input");

    expect(answer).toMatchObject({ state: "working", orderState: "INPUT_REQUIRED" });
    expect((await current()).capabilityEpoch).toBe(1);
  }, 60_000);

  it("still surfaces any other transition failure", async () => {
    const service = gateway(completedProvider());
    const transition = vi.spyOn(store, "transition").mockRejectedValueOnce(new Error("connection terminated"));

    await expect(status(service)).rejects.toThrow("connection terminated");
    expect((await current()).state).toBe("DISPATCHED");
    transition.mockRestore();
  }, 60_000);
});
