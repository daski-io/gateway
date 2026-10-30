import { COMMITTED_KEYS_ONLY } from "../src/standardRail/providerAuthority.js";
import { createHash, randomUUID } from "node:crypto";
import { localGatewaySigners } from "../src/standardRail/signer.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS } from "../src/standardRail/dispatchQuoteAge.js";
import type { EvidenceResult, ReleaseEvidenceResult } from "../src/standardRail/evidence.js";
import { StandardRailIncidentStore } from "../src/standardRail/incidents.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { StandardRailOperator } from "../src/standardRail/operator.js";
import { StandardProviderDispatch } from "../src/standardRail/providerDispatch.js";
import { issueReadCapability } from "../src/standardRail/readCapability.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import type { SignedEnvelope, StandardOrderRecord, StandardRailDispatchV2 } from "../src/standardRail/types.js";
import { STANDARD_RECEIPT_V2_KEYS } from "../src/standardRail/wireContracts.js";

/// A dispatched order fails at its original dispatch resolution plus the
/// longest of its checkout snapshot's duration, a duration already recorded
/// for it and the duration of the listing that services it now, plus its
/// admitted prerequisite waits. These tests drive recovery over the real order
/// store, dispatch journal, operations store and provider dispatcher against a
/// fake provider; only the catalog's servicing answer is scripted (its lookup
/// is covered in standardRailDynamicCatalog.test.ts). Time passes by moving the
/// recorded dispatch resolution back.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const CHAIN_ID = 84_532;
const MINUTE = 60;
const HOUR = 3_600;
const KEY = `0x${"11".repeat(32)}` as Hex;
const provider = privateKeyToAccount(`0x${"22".repeat(32)}`);
const payer = privateKeyToAccount(`0x${"33".repeat(32)}`);
const PROVIDER_AUDIENCE = "https://provider.example";
const GATEWAY_AUDIENCE = "https://gateway.example";
const SERVICE_ID = `0x${"2".repeat(64)}` as Hex;
const LISTING_HASH = `0x${"4".repeat(64)}` as Hex;
const RAIL_PROFILE_HASH = `0x${"0".repeat(64)}` as Hex;
const railConfig = {
  environment: "testnet", gatewayAudience: GATEWAY_AUDIENCE, encryptionKey: Buffer.alloc(32, 7),
  signers: localGatewaySigners(KEY), trustedSigners: new Map(), dispatchTimeoutMs: 3_000,
  reputationContract: `0x${"6".repeat(40)}` as Hex, reputationOutcomeSchemaUid: `0x${"9".repeat(64)}` as Hex,
  manifest: { providerIdentitySnapshots: [] },
};

const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;
const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const filled = (n: number, salt: number): Buffer => Buffer.alloc(32, n * 16 + salt);
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const orderId = (n: number) => `ord_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const taskOf = (id: string) => `task-${id.slice(-12)}`;
const depositEvidence = (n: number) => ({ kind: "deposit", orderId: orderId(n) });
const releaseEvidence = (n: number) => ({ kind: "release", orderId: orderId(n),
  observations: [{ allocation: { providerNetAmount: "90", daskiCommissionAmount: "10", releaseSequence: "1" } }] });

function listing(fulfillmentSeconds: number, purchaseReadiness: "payer_dns" | null = null) {
  return {
    commitment: { payload: {
      providerAgentId: "7", serviceId: SERVICE_ID, outcomeId: "audit", bindingProfile: "recipe-bound-v2",
      providerControlProfileHash: `0x${"1".repeat(64)}`, providerAuthorityKey: provider.address,
      providerTerminalAttestationKey: provider.address, providerPayee: `0x${"3".repeat(40)}`,
      daskiCommissionReceiver: `0x${"4".repeat(40)}`,
    } },
    manifest: { payload: { splitterAddress: `0x${"5".repeat(40)}` } },
    providerOwner: `0x${"8".repeat(40)}`, providerAgentWallet: provider.address,
    screeningPolicy: { providerControlledWallets: [] },
    providerControlProfile: { payload: {
      providerAudience: PROVIDER_AUDIENCE, origin: `${PROVIDER_AUDIENCE}/`,
      dispatchUrl: `${PROVIDER_AUDIENCE}/dispatch`, dispatchStatusUrl: `${PROVIDER_AUDIENCE}/dispatch/status`,
      lifecycleUrl: `${PROVIDER_AUDIENCE}/lifecycle`, timeoutMs: 3_000, maxResponseBytes: 65_536,
    } },
    purchaseReadiness,
    deadlinePolicy: { dispatchSeconds: 300, fulfillmentSeconds },
  };
}

function evidence(n: number): { deposit: EvidenceResult; release: ReleaseEvidenceResult } {
  return {
    deposit: { transactionHash: hex(filled(n, 8)), blockNumber: 100n, blockHash: hex(filled(n, 13)), transactionIndex: 1,
      logIndex: 2, evidenceHash: canonicalHash(depositEvidence(n)), canonicalEvidence: depositEvidence(n), sources: ["rpc-a"] },
    release: { transactionHash: hex(filled(n, 9)), blockNumber: 101n, blockHash: hex(filled(n, 14)), transactionIndex: 3,
      logIndex: 4, evidenceHash: canonicalHash(releaseEvidence(n)), canonicalEvidence: releaseEvidence(n), sources: ["rpc-a"],
      providerNetAmount: 90n, daskiCommissionAmount: 10n, releaseSequence: 1n },
  };
}

/** The signed dispatch an accepted claim retains; recovery polls its hash. */
async function dispatchEnvelope(n: number): Promise<SignedEnvelope<StandardRailDispatchV2, 2>> {
  const issuedAt = nowSeconds() - 2 * 86_400;
  const value = (salt: number) => hex(filled(n, salt));
  const { deposit, release } = evidence(n);
  return signEnvelope<StandardRailDispatchV2, 2>({
    artifactType: "StandardRailDispatchV2", schemaVersion: 2, environment: "testnet", chainId: CHAIN_ID,
    audience: PROVIDER_AUDIENCE, signerKeyId: "gateway-dispatch", account: privateKeyToAccount(KEY), issuedAt, validBefore: issuedAt + 300,
    payload: {
      environment: "testnet", chainId: CHAIN_ID, gatewayAudience: GATEWAY_AUDIENCE, providerAudience: PROVIDER_AUDIENCE,
      providerControlProfileHash: `0x${"1".repeat(64)}`, orderId: orderId(n), orderKey: value(1), serviceId: SERVICE_ID,
      reputationEligible: true, reputationContract: railConfig.reputationContract,
      outcomeSchemaUid: railConfig.reputationOutcomeSchemaUid, dispatchNonce: value(11), payer: payer.address,
      listingManifestHash: LISTING_HASH, providerOfferHash: value(2), quoteHash: value(3), bindingProfile: "recipe-bound-v2",
      canonicalRequestHash: value(4), orderNonce: value(5), buyerIdentityProofHash: RAIL_PROFILE_HASH,
      activeRailProfileHash: RAIL_PROFILE_HASH, facilitatorConfirmationHash: value(12),
      settlementTxHash: deposit.transactionHash, depositBlockNumber: "100", depositBlockHash: deposit.blockHash,
      depositTransactionIndex: 1, depositLogIndex: 2, depositEvidenceHash: deposit.evidenceHash,
      releaseTxHash: release.transactionHash, releaseBlockNumber: "101", releaseBlockHash: release.blockHash,
      releaseTransactionIndex: 3, releaseLogIndex: 4, releaseSequence: "1", releaseEvidenceHash: release.evidenceHash,
      grossAmount: "100", providerNetAmount: "90", daskiCommissionAmount: "10",
      canonicalProviderRequestHash: canonicalHash({}), dispatchDeadlineSeconds: 300, issuedAt, validBefore: issuedAt + 300,
    } as unknown as StandardRailDispatchV2,
  });
}

/**
 * A paid order with its proven deposit and release, dispatched when its state
 * says so. Its quote expired as its release was observed.
 */
async function seed(pool: Pool, n: number, args: {
  state: "DISPATCHED" | "RELEASE_FINAL";
  fulfillmentSeconds: number;
  purchaseReadiness?: "payer_dns";
  resolvedSecondsAgo?: number;
  releaseObservedSecondsAgo?: number;
}): Promise<string> {
  const id = orderId(n);
  const handle = `handle-${n}`;
  const dispatched = args.state === "DISPATCHED";
  const { deposit, release } = evidence(n);
  const observedAgo = args.releaseObservedSecondsAgo ?? (args.resolvedSecondsAgo ?? 0) + MINUTE;
  await pool.query(`INSERT INTO standard_orders (
    order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
    canonical_request,order_nonce,intent_id,authorization_key,payment_payload_hash,payer,gross_amount,
    provider_net_amount,daski_commission_amount,settlement_tx_hash,deposit_evidence_hash,release_tx_hash,
    release_evidence_hash,provider_task_id,rail_epoch,listing_epoch,expires_at)
    VALUES ($1,$2,$3,$4,$5,'7','audit','recipe-bound-v2',$6,$7,$8,$9,$21,$10,'{}',$11,$12,$13,$14,$15,
      100,90,10,$16,$17,$18,$19,$20,1,1,now()+interval '1 hour')`,
  [id, filled(n, 1), handle, createHash("sha256").update(handle).digest(), args.state, bytes(LISTING_HASH), filled(n, 2),
    listing(args.fulfillmentSeconds, args.purchaseReadiness ?? null), filled(n, 3), filled(n, 4), filled(n, 5),
    `int_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, filled(n, 6), filled(n, 7), payer.address,
    deposit.transactionHash, bytes(deposit.evidenceHash), release.transactionHash, bytes(release.evidenceHash),
    dispatched ? taskOf(id) : null, { artifactType: "QuoteV1", payload: { validBefore: nowSeconds() - observedAgo } }]);
  for (const [kind, proof, canonical] of [["deposit", deposit, depositEvidence(n)], ["release", release, releaseEvidence(n)]] as const) {
    await pool.query(`INSERT INTO standard_chain_evidence (evidence_hash,order_id,evidence_kind,chain_id,block_number,
      block_hash,transaction_hash,transaction_index,log_index,source_fingerprints,canonical_evidence,observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'["rpc-a"]',$10,now()-make_interval(secs=>$11))`,
    [bytes(proof.evidenceHash), id, kind, CHAIN_ID, proof.blockNumber.toString(), proof.blockHash, proof.transactionHash,
      proof.transactionIndex, proof.logIndex, canonical, observedAgo]);
  }
  if (dispatched) {
    const dispatch = await dispatchEnvelope(n);
    await pool.query(`INSERT INTO standard_dispatch_claims (order_id,dispatch_nonce,dispatch_hash,request_hash,
      invocation_state,provider_task_id,response_hash,canonical_dispatch,canonical_request,invoked_at,resolved_at)
      VALUES ($1,$2,$3,$4,'accepted',$5,$6,$7,'{}',now()-make_interval(secs=>$8),now()-make_interval(secs=>$8))`,
    [id, filled(n, 11), bytes(canonicalHash(dispatch)), bytes(canonicalHash({})), taskOf(id), filled(n, 10), dispatch,
      args.resolvedSecondsAgo ?? 0]);
  }
  return id;
}

/** A provider that answers dispatch, dispatch status and lifecycle calls with signed bodies. */
function providerDesk() {
  const desk = {
    state: "working",
    revision: 0,
    fulfillment: null as Record<string, unknown> | null,
    result: { reportUrl: "https://provider.example/reports/1" },
    completedAt: 0,
    refuseDispatches: 0,
    dispatchStatusDown: false,
    dispatchStatusUnreachable: false,
    dispatchTerminal: false,
    duringLifecycle: null as (() => Promise<unknown>) | null,
    dispatched: [] as SignedEnvelope<StandardRailDispatchV2, 2>[],
  };
  const operations = () => ({ schemaVersion: 1, revision: desk.revision, observedAt: nowSeconds(),
    fulfillment: desk.fulfillment, support: null, recovery: null });
  const sign = async (payload: Record<string, unknown>) =>
    provider.signMessage({ message: { raw: canonicalHash(payload) } });
  const signed = async (body: Record<string, unknown>) => Response.json({ ...body, signature: await sign(body) });
  const fetch = vi.fn(async (_listing: unknown, url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/dispatch/status")) {
      if (desk.dispatchStatusUnreachable) throw new TypeError("fetch failed");
      if (desk.dispatchStatusDown) return Response.json({ error: "unavailable" }, { status: 503 });
      const query = body.query.payload as { orderId: string; dispatchHash: Hex };
      const answer = { taskId: taskOf(query.orderId), dispatchHash: query.dispatchHash, state: desk.state,
        operations: operations() };
      if (!desk.dispatchTerminal) return signed(answer);
      const payload = { taskId: answer.taskId, dispatchHash: answer.dispatchHash, state: desk.state,
        resultHash: canonicalHash(desk.result), completedAt: desk.completedAt };
      return Response.json({ ...answer, signature: await sign(answer),
        terminalAttestation: { payload, signature: await sign(payload) } });
    }
    if (url.endsWith("/dispatch")) {
      const dispatch = body.dispatch as SignedEnvelope<StandardRailDispatchV2, 2>;
      desk.dispatched.push(dispatch);
      if (desk.refuseDispatches > 0) {
        desk.refuseDispatches -= 1;
        return Response.json({ error: "not_ready" }, { status: 409 });
      }
      return signed({ taskId: taskOf(dispatch.payload.orderId), dispatchHash: canonicalHash(dispatch), state: "working",
        operations: operations() });
    }
    await desk.duringLifecycle?.();
    const answer: Record<string, unknown> = { orderId: body.orderId, taskId: body.providerTaskId, state: desk.state,
      operations: operations() };
    if (body.action === "artifact") answer.result = desk.result;
    if (desk.state === "completed") {
      const payload = { orderId: body.orderId, taskId: body.providerTaskId, state: "completed",
        resultHash: canonicalHash(desk.result), completedAt: desk.completedAt };
      answer.terminalAttestation = { payload, signature: await sign(payload) };
    }
    return signed(answer);
  });
  return Object.assign(desk, { fetch });
}

function gateway(pool: Pool, desk: ReturnType<typeof providerDesk>) {
  const store = new StandardRailStore(pool);
  const journal = new StandardRailJournal(pool);
  const dispatcher = new StandardProviderDispatch({ chainId: CHAIN_ID }, railConfig as never, journal, store,
    desk.fetch as never, RAIL_PROFILE_HASH, COMMITTED_KEYS_ONLY);
  const servicing: { seconds: number | null | Error } = { seconds: null };
  const servicingFulfillmentSeconds = vi.fn(async (_order: StandardOrderRecord): Promise<number | null> => {
    if (servicing.seconds instanceof Error) throw servicing.seconds;
    return servicing.seconds;
  });
  // The sale-time lookup refuses closed commerce; servicing never consults it.
  const commerceListing = vi.fn(async () => { throw new Error("OUTCOME_NOT_FOUND"); });
  const service = Object.assign(Object.create(StandardRailService.prototype), {
    appConfig: { chainId: CHAIN_ID, publicUrl: GATEWAY_AUDIENCE },
    railConfig, railProfileHash: RAIL_PROFILE_HASH,
    assertRailFence: async () => undefined,
    store, journal, dispatcher,
    catalog: { servicingFulfillmentSeconds },
    listing: commerceListing,
    incidents: new StandardRailIncidentStore(pool),
    providerFetch: desk.fetch,
    validateResponse: async () => undefined,
    confirmationState: { stored: async () => null },
    submissionStatus: async () => null,
  }) as StandardRailService;
  const resume = (id: string) => (service as unknown as {
    resumePaidOrder(order: StandardOrderRecord): Promise<void>;
  }).resumePaidOrder({ orderId: id } as StandardOrderRecord);
  return { service, store, journal, dispatcher, servicing, servicingFulfillmentSeconds, commerceListing, resume };
}

async function order(pool: Pool, id: string) {
  return (await pool.query<{ state: string; effective_fulfillment_seconds: string | null; version: string; updated_at: Date }>(
    "SELECT state,effective_fulfillment_seconds,version,updated_at FROM standard_orders WHERE order_id=$1", [id])).rows[0]!;
}
async function transitions(pool: Pool, id: string) {
  return (await pool.query<{ from_state: string; to_state: string; reason_code: string }>(
    "SELECT from_state,to_state,reason_code FROM standard_order_transitions WHERE order_id=$1 ORDER BY transition_id",
    [id])).rows;
}
async function resolvedAt(pool: Pool, id: string): Promise<Date> {
  return (await pool.query<{ resolved_at: Date }>("SELECT resolved_at FROM standard_dispatch_claims WHERE order_id=$1",
    [id])).rows[0]!.resolved_at;
}
/** Moves the original dispatch resolution back: `seconds` have now passed since it. */
async function resolvedSecondsAgo(pool: Pool, id: string, seconds: number): Promise<void> {
  await pool.query("UPDATE standard_dispatch_claims SET resolved_at=now()-make_interval(secs=>$2) WHERE order_id=$1",
    [id, seconds]);
}
/** Moves the order's quote expiry back: `seconds` have now passed since it. */
async function quoteExpiredSecondsAgo(pool: Pool, id: string, seconds: number): Promise<void> {
  await pool.query(`UPDATE standard_orders
    SET canonical_quote=jsonb_set(canonical_quote,'{payload,validBefore}',to_jsonb($2::bigint)) WHERE order_id=$1`,
  [id, nowSeconds() - seconds]);
}
async function waitSeconds(pool: Pool, id: string): Promise<string> {
  return (await pool.query<{ wait_seconds: string }>("SELECT wait_seconds FROM standard_order_operations WHERE order_id=$1",
    [id])).rows[0]!.wait_seconds;
}
const deadlineFailure = { from_state: "DISPATCHED", to_state: "PROVIDER_FAILED", reason_code: "signed_provider_deadline_elapsed" };

async function schemaPool(prefix: string) {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 4 });
  return {
    pool,
    async close() {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    },
  };
}

let database: Awaited<ReturnType<typeof schemaPool>>;
let pool: Pool;
beforeAll(async () => {
  database = await schemaPool("fulfillment_deadline");
  pool = database.pool;
  await runMigrations(pool);
}, 120_000);
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  await pool.query("TRUNCATE standard_orders, standard_operator_actions CASCADE");
});

describe("fulfillment deadline (postgres)", () => {
  it("keeps a 12-hour snapshot from the original dispatch resolution when the listing shortens", async () => {
    const gw = gateway(pool, providerDesk());
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: 11 * HOUR });
    gw.servicing.seconds = 6 * HOUR;
    await gw.resume(id);
    expect(await order(pool, id)).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: null });
    await resolvedSecondsAgo(pool, id, 12 * HOUR - MINUTE);
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    await resolvedSecondsAgo(pool, id, 12 * HOUR + MINUTE);
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
    expect(await transitions(pool, id)).toEqual([deadlineFailure]);
    expect(gw.commerceListing).not.toHaveBeenCalled();
  });

  it("records a longer duration that a shorter or missing listing, a failed lookup or a restart cannot retract", async () => {
    let gw = gateway(pool, providerDesk());
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    const before = await order(pool, id);
    const resolution = await resolvedAt(pool, id);
    gw.servicing.seconds = 48 * HOUR;
    await gw.resume(id);
    const extended = await order(pool, id);
    expect(extended).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: String(48 * HOUR),
      version: String(Number(before.version) + 1) });
    // The clock keeps its origin.
    expect(extended.updated_at).toEqual(before.updated_at);
    expect(await resolvedAt(pool, id)).toEqual(resolution);

    await resolvedSecondsAgo(pool, id, 13 * HOUR);
    for (const answer of [6 * HOUR, new Error("catalog unavailable"), null]) {
      gw.servicing.seconds = answer;
      await gw.resume(id);
      expect(await order(pool, id)).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: String(48 * HOUR) });
    }
    // A restarted gateway reads the recorded duration back and still enforces it.
    gw = gateway(pool, providerDesk());
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    await resolvedSecondsAgo(pool, id, 48 * HOUR + MINUTE);
    gw.servicing.seconds = new Error("catalog unavailable");
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
    expect(await transitions(pool, id)).toEqual([deadlineFailure]);
    expect(gw.commerceListing).not.toHaveBeenCalled();
  });

  it("fences the recorded duration by the order's version and keeps the clock when the write fails", async () => {
    const gw = gateway(pool, providerDesk());
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: 13 * HOUR });
    const resolution = await resolvedAt(pool, id);
    // A concurrent writer moves the order on between its read and the write.
    gw.servicingFulfillmentSeconds.mockImplementationOnce(async () => {
      await pool.query("UPDATE standard_orders SET version=version+1 WHERE order_id=$1", [id]);
      return 48 * HOUR;
    });
    await expect(gw.resume(id)).rejects.toThrow("ORDER_FULFILLMENT_EXTENSION_CONFLICT");
    expect(await order(pool, id)).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: null });
    expect(await resolvedAt(pool, id)).toEqual(resolution);
    gw.servicing.seconds = 48 * HOUR;
    await gw.resume(id);
    expect(await order(pool, id)).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: String(48 * HOUR) });
    // Nothing writes a shorter duration over it.
    await expect(gw.store.extendFulfillment((await gw.store.findById(id))!, 24 * HOUR))
      .rejects.toThrow("ORDER_FULFILLMENT_EXTENSION_CONFLICT");
    expect((await order(pool, id)).effective_fulfillment_seconds).toBe(String(48 * HOUR));
  });

  it("gives all-null and unadmitted operations no wait exemption", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const audit = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR,
      resolvedSecondsAgo: 12 * HOUR - MINUTE });
    await gw.resume(audit);
    expect((await order(pool, audit)).state).toBe("DISPATCHED");
    await resolvedSecondsAgo(pool, audit, 12 * HOUR + MINUTE);
    await gw.resume(audit);
    expect((await order(pool, audit)).state).toBe("PROVIDER_FAILED");

    // A wait this listing never admitted is stored as signed, yet pauses nothing.
    const claimed = await seed(pool, 2, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR,
      resolvedSecondsAgo: 12 * HOUR + MINUTE });
    desk.revision = 1;
    desk.fulfillment = { phase: "dns_pending", reasons: [], pendingSince: null, lastCheckedAt: null,
      nextCheckAt: nowSeconds() + 300, missingRecords: [], accumulatedWaitSeconds: 2 * HOUR };
    await gw.resume(claimed);
    expect(await waitSeconds(pool, claimed)).toBe(String(2 * HOUR));
    expect((await order(pool, claimed)).state).toBe("PROVIDER_FAILED");
  });

  it("keeps admitted prerequisite waits under their existing validation", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, purchaseReadiness: "payer_dns",
      resolvedSecondsAgo: 13 * HOUR });
    const view = (phase: string, accumulatedWaitSeconds: number) => ({ phase, reasons: [], pendingSince: null,
      lastCheckedAt: null, nextCheckAt: nowSeconds() + 300, missingRecords: [], accumulatedWaitSeconds });
    desk.revision = 1;
    desk.fulfillment = view("dns_pending", HOUR);
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    expect(gw.servicingFulfillmentSeconds).not.toHaveBeenCalled();
    const provisioning = view("provisioning", 2 * HOUR);
    desk.revision = 2;
    desk.fulfillment = provisioning;
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    // A wait clock that runs backwards is refused; the validated wait stays.
    desk.revision = 3;
    desk.fulfillment = view("provisioning", HOUR);
    await expect(gw.resume(id)).rejects.toThrow("provider_wait_clock_regressed");
    expect(await waitSeconds(pool, id)).toBe(String(2 * HOUR));
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    desk.revision = 2;
    desk.fulfillment = provisioning;
    await resolvedSecondsAgo(pool, id, 14 * HOUR + MINUTE);
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
  });
});

describe("initial dispatch recovery (postgres)", () => {
  const dispatch = async (gw: ReturnType<typeof gateway>, n: number) => {
    const current = (await gw.store.findById(orderId(n)))!;
    return gw.dispatcher.dispatch(current, current.listing, current.canonicalRequest,
      canonicalHash({ orderId: current.orderId, recovered: true }), evidence(n));
  };

  it("dispatches a timely-paid order afresh beyond 24 hours and stops at its snapshot horizon", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "RELEASE_FINAL", fulfillmentSeconds: 72 * HOUR,
      releaseObservedSecondsAgo: 25 * HOUR });
    desk.refuseDispatches = 1;
    expect((await dispatch(gw, 1)).state).toBe("DISPATCH_STARTED");
    await pool.query("UPDATE standard_dispatch_recovery SET next_attempt_at=now()-interval '1 second' WHERE order_id=$1", [id]);
    expect((await dispatch(gw, 1)).state).toBe("DISPATCHED");
    const [refused, fresh] = desk.dispatched;
    expect(desk.dispatched).toHaveLength(2);
    // A new signed envelope, never the refused one again.
    expect(fresh!.payload.dispatchNonce).not.toBe(refused!.payload.dispatchNonce);
    expect(canonicalHash(fresh)).not.toBe(canonicalHash(refused));
    expect(Math.abs(fresh!.issuedAt - nowSeconds())).toBeLessThanOrEqual(5);
    expect(fresh!.validBefore).toBe(fresh!.issuedAt + 300);
    const recovery = await gw.journal.dispatchRecovery(id);
    expect(Date.now() - recovery.started_at.getTime()).toBeGreaterThan(25 * HOUR * 1_000 - 5_000);

    const late = await seed(pool, 2, { state: "RELEASE_FINAL", fulfillmentSeconds: 72 * HOUR,
      releaseObservedSecondsAgo: 72 * HOUR + MINUTE });
    expect((await dispatch(gw, 2)).state).toBe("PROVIDER_FAILED");
    expect(desk.dispatched).toHaveLength(2);
    expect(await transitions(pool, late)).toEqual([{ from_state: "RELEASE_FINAL", to_state: "PROVIDER_FAILED",
      reason_code: "provider_dispatch_fulfillment_deadline_elapsed" }]);
    expect(gw.servicingFulfillmentSeconds).not.toHaveBeenCalled();
  });

  it("holds a refused order whose quote passes the first-dispatch bound before its retry, sending nothing new", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "RELEASE_FINAL", fulfillmentSeconds: 45 * 24 * HOUR,
      releaseObservedSecondsAgo: MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS - MINUTE });
    desk.refuseDispatches = 1;
    expect((await dispatch(gw, 1)).state).toBe("DISPATCH_STARTED");
    // By the time its retry falls due, the quote is past the bound.
    await quoteExpiredSecondsAgo(pool, id, MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS + MINUTE);
    await pool.query("UPDATE standard_dispatch_recovery SET next_attempt_at=now()-interval '1 second' WHERE order_id=$1", [id]);
    expect((await dispatch(gw, 1)).state).toBe("LEGAL_HOLD");
    expect(desk.dispatched).toHaveLength(1);
    expect(await transitions(pool, id)).toEqual([
      { from_state: "RELEASE_FINAL", to_state: "DISPATCH_STARTED", reason_code: "dispatch_invocation_persisted" },
      { from_state: "DISPATCH_STARTED", to_state: "LEGAL_HOLD", reason_code: "first_dispatch_quote_age_exceeded" },
    ]);
    // The refused envelope stays the order's only claim.
    expect((await pool.query("SELECT canonical_dispatch FROM standard_dispatch_claims WHERE order_id=$1", [id])).rows)
      .toEqual([{ canonical_dispatch: desk.dispatched[0] }]);
  });

  it("holds a redispatched order whose quote is past the bound, and its listing's purchases still settle", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "RELEASE_FINAL", fulfillmentSeconds: 72 * HOUR,
      releaseObservedSecondsAgo: MAX_FIRST_DISPATCH_QUOTE_AGE_SECONDS + HOUR });
    expect((await dispatch(gw, 1)).state).toBe("PROVIDER_FAILED");
    // The redispatch opens a fresh dispatch window, but the quote is past the bound.
    await expect(new StandardRailOperator(pool).redispatch(id)).resolves.toMatchObject({ state: "RELEASE_FINAL" });
    expect((await dispatch(gw, 1)).state).toBe("LEGAL_HOLD");
    expect(desk.dispatched).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM standard_dispatch_claims WHERE order_id=$1", [id])).rowCount).toBe(0);
    expect(await transitions(pool, id)).toEqual([
      { from_state: "RELEASE_FINAL", to_state: "PROVIDER_FAILED", reason_code: "provider_dispatch_fulfillment_deadline_elapsed" },
      { from_state: "PROVIDER_FAILED", to_state: "RELEASE_FINAL", reason_code: "operator_redispatch" },
      { from_state: "RELEASE_FINAL", to_state: "LEGAL_HOLD", reason_code: "first_dispatch_quote_age_exceeded" },
    ]);
    // Its release is proven, so the hold does not stop the listing's next purchase settling.
    const next = await seed(pool, 2, { state: "RELEASE_FINAL", fulfillmentSeconds: 72 * HOUR });
    expect(await gw.store.listingSettlementFrozen(LISTING_HASH, next)).toBe(false);
  });
});

/** A signed provider terminal already stored, as a read that lost its transition leaves it. */
async function storeTerminal(gw: ReturnType<typeof gateway>, id: string, state: "completed" | "failed", args: {
  fulfillment?: Record<string, unknown>; taskId?: string;
} = {}): Promise<void> {
  const payload = { orderId: id, taskId: args.taskId ?? taskOf(id), state, resultHash: `0x${"ab".repeat(32)}`, completedAt: nowSeconds() - 5 };
  await gw.store.persistOperations(id, { schemaVersion: 1, revision: 1, observedAt: nowSeconds(),
    fulfillment: args.fulfillment ?? null, support: null, recovery: null }, {
    payload, signature: await provider.signMessage({ message: { raw: canonicalHash(payload) } }),
  });
}

const storedCompletion = { from_state: "DISPATCHED", to_state: "FULFILLED", reason_code: "stored_provider_completion" };

describe("stored provider terminal (postgres)", () => {
  it("fulfills a stored completion past the deadline while dispatch status stays down", async () => {
    const desk = providerDesk();
    desk.dispatchStatusDown = true;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: 13 * HOUR });
    await storeTerminal(gw, id, "completed");

    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([storedCompletion]);
  });

  it("fulfills a stored completion before the deadline while dispatch status is unreachable", async () => {
    const desk = providerDesk();
    desk.dispatchStatusUnreachable = true;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await storeTerminal(gw, id, "completed");

    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([storedCompletion]);
  });

  it("fulfills a stored completion ahead of an admitted wait", async () => {
    const desk = providerDesk();
    desk.dispatchStatusDown = true;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR,
      purchaseReadiness: "payer_dns" });
    await storeTerminal(gw, id, "completed", { fulfillment: { phase: "dns_pending", reasons: [], pendingSince: nowSeconds() - MINUTE,
      lastCheckedAt: nowSeconds(), nextCheckAt: nowSeconds() + MINUTE, missingRecords: [], accumulatedWaitSeconds: 0 } });

    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([storedCompletion]);
  });

  it("fulfills an INPUT_REQUIRED order from a stored completion", async () => {
    const desk = providerDesk();
    desk.dispatchStatusDown = true;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await pool.query("UPDATE standard_orders SET state='INPUT_REQUIRED' WHERE order_id=$1", [id]);
    await storeTerminal(gw, id, "completed");

    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([{ ...storedCompletion, from_state: "INPUT_REQUIRED" }]);
  });

  it("carries a status read that lost its fence through a dispatch status outage", async () => {
    const desk = providerDesk();
    desk.dispatchStatusDown = true;
    desk.state = "completed";
    desk.completedAt = nowSeconds() - 5;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    desk.duringLifecycle = () => gw.store.leaseOrder(id, "standard-recovery-worker", 45);
    const { readCapability } = issueReadCapability({ key: railConfig.encryptionKey, orderId: id, payer: payer.address,
      audience: GATEWAY_AUDIENCE, capabilityEpoch: 0, ttlSeconds: 60 });

    await expect(gw.service.performAction({ handle: "handle-1", action: "status", request: {}, readCapability }))
      .resolves.toMatchObject({ state: "completed", orderState: "DISPATCHED" });
    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([storedCompletion]);
  });

  it("keeps the order open when the provider's signed status contradicts the stored completion", async () => {
    const desk = providerDesk();
    desk.state = "failed";
    desk.dispatchTerminal = true;
    desk.completedAt = nowSeconds() - 5;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await storeTerminal(gw, id, "completed");

    await expect(gw.resume(id)).rejects.toThrow("provider_original_terminal_changed");

    expect(await transitions(pool, id)).toEqual([]);
  });

  it("keeps the order open when a fresh signed status says the task is active", async () => {
    const gw = gateway(pool, providerDesk());
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await storeTerminal(gw, id, "completed");

    await gw.resume(id);

    expect(await transitions(pool, id)).toEqual([]);
  });

  it("ignores a stored completion for another task", async () => {
    const desk = providerDesk();
    desk.dispatchStatusDown = true;
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await storeTerminal(gw, id, "completed", { taskId: "task-from-an-earlier-dispatch" });

    await expect(gw.resume(id)).rejects.toThrow("PROVIDER_DISPATCH_STATUS_UNAVAILABLE");

    expect(await transitions(pool, id)).toEqual([]);
  });

  it("leaves a stored failure to the deadline", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: HOUR });
    await storeTerminal(gw, id, "failed");

    await gw.resume(id);
    expect(await transitions(pool, id)).toEqual([]);

    await resolvedSecondsAgo(pool, id, 13 * HOUR);
    await gw.resume(id);
    expect(await transitions(pool, id)).toEqual([deadlineFailure]);
  });
});

describe("deadline expiry (postgres)", () => {
  it("keeps a late completion readable without reviving or refunding the failed order", async () => {
    const desk = providerDesk();
    const gw = gateway(pool, desk);
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: 13 * HOUR });
    await gw.resume(id);
    expect(await transitions(pool, id)).toEqual([deadlineFailure]);

    // The provider finishes its job after the gateway's deadline.
    desk.state = "completed";
    desk.completedAt = nowSeconds() - 5;
    const { readCapability } = issueReadCapability({ key: railConfig.encryptionKey, orderId: id, payer: payer.address,
      audience: GATEWAY_AUDIENCE, capabilityEpoch: 0, ttlSeconds: 60 });
    const read = (action: "status" | "artifact") => gw.service.performAction({
      handle: "handle-1", action, request: {}, readCapability,
    }) as Promise<Record<string, unknown>>;
    const status = await read("status");
    const artifact = await read("artifact");
    const lifecycleKeys = ["orderId", "taskId", "state", "operations", "terminalAttestation", "signature",
      "orderHandle", "orderKey", "orderState", "fulfillmentState", "receipt"];
    expect(Object.keys(status).sort()).toEqual([...lifecycleKeys, "confirmationFinal", "submission"].sort());
    expect(Object.keys(artifact).sort()).toEqual([...lifecycleKeys, "result"].sort());
    expect(status).toMatchObject({ state: "completed", orderState: "PROVIDER_FAILED", fulfillmentState: "completed" });
    expect(artifact).toMatchObject({ result: desk.result, orderState: "PROVIDER_FAILED", fulfillmentState: "completed" });
    // The receipt is the payment's own record, the same on every read.
    const receipt = artifact.receipt as SignedEnvelope<Record<string, unknown>, 2>;
    expect(receipt.payload.state).toBe("RELEASE_FINAL");
    expect(Object.keys(receipt.payload).sort()).toEqual([...STANDARD_RECEIPT_V2_KEYS].sort());
    expect(status.receipt).toEqual(receipt);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
    expect(await transitions(pool, id)).toEqual([deadlineFailure]);

    // Only an operator revives a failed order, and only while its task still works.
    const operator = new StandardRailOperator(pool, undefined, async () => "completed");
    await expect(operator.redispatch(id)).rejects.toThrow("provider_task_not_active:completed");
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
  });

  it("revives a still-working deadline-failed order only by operator, from its original dispatch resolution", async () => {
    const gw = gateway(pool, providerDesk());
    const id = await seed(pool, 1, { state: "DISPATCHED", fulfillmentSeconds: 12 * HOUR, resolvedSecondsAgo: 13 * HOUR });
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
    const resolution = await resolvedAt(pool, id);
    const operator = new StandardRailOperator(pool, undefined, async () => "working");
    await expect(operator.redispatch(id)).resolves.toEqual({ orderId: id, state: "DISPATCHED" });
    expect(await resolvedAt(pool, id)).toEqual(resolution);
    // Revival keeps the clock: with nothing longer on offer, the order fails again.
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("PROVIDER_FAILED");
    await operator.redispatch(id);
    // A longer current listing is recorded, then holds after it disappears.
    gw.servicing.seconds = 48 * HOUR;
    await gw.resume(id);
    expect(await order(pool, id)).toMatchObject({ state: "DISPATCHED", effective_fulfillment_seconds: String(48 * HOUR) });
    gw.servicing.seconds = null;
    await gw.resume(id);
    expect((await order(pool, id)).state).toBe("DISPATCHED");
    expect(await resolvedAt(pool, id)).toEqual(resolution);
    expect((await transitions(pool, id)).map((transition) => transition.reason_code)).toEqual([
      "signed_provider_deadline_elapsed", "operator_revived", "signed_provider_deadline_elapsed", "operator_revived",
    ]);
  });
});

describe("orders that predate the recorded duration (postgres)", () => {
  it("start from their snapshot and gain only a duration the catalog still verifies", async () => {
    const legacy = await schemaPool("fulfillment_legacy");
    try {
      await runMigrations(legacy.pool, { through: "059_retirement_journal_serialization.sql" });
      const snapshotOnly = await seed(legacy.pool, 1, { state: "DISPATCHED", fulfillmentSeconds: HOUR,
        resolvedSecondsAgo: 2 * HOUR });
      const verified = await seed(legacy.pool, 2, { state: "DISPATCHED", fulfillmentSeconds: HOUR,
        resolvedSecondsAgo: 2 * HOUR });
      await runMigrations(legacy.pool);
      expect((await legacy.pool.query(
        "SELECT order_id,state,effective_fulfillment_seconds FROM standard_orders ORDER BY order_id")).rows).toEqual([
        { order_id: snapshotOnly, state: "DISPATCHED", effective_fulfillment_seconds: null },
        { order_id: verified, state: "DISPATCHED", effective_fulfillment_seconds: null },
      ]);
      const gw = gateway(legacy.pool, providerDesk());
      // Nothing beyond the one-hour snapshot is known for this order.
      await gw.resume(snapshotOnly);
      expect(await transitions(legacy.pool, snapshotOnly)).toEqual([deadlineFailure]);
      // This one's own retained version resolves to today's 30-day default.
      gw.servicing.seconds = 2_592_000;
      await gw.resume(verified);
      expect(await order(legacy.pool, verified)).toMatchObject({ state: "DISPATCHED",
        effective_fulfillment_seconds: "2592000" });
    } finally { await legacy.close(); }
  }, 120_000);
});
