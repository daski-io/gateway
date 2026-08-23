import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "../src/db/pool.js";
import { StandardRailRecoveryWorker } from "../src/standardRail/recovery.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";

type ServiceHarness = StandardRailService & Record<string, unknown>;

function harness(fields: Record<string, unknown>): ServiceHarness {
  const service = Object.create(StandardRailService.prototype) as ServiceHarness;
  Object.assign(service, fields);
  return service;
}

type Drive = (
  handle: string,
  claimed: StandardOrderRecord,
  work: (order: StandardOrderRecord) => Promise<StandardOrderRecord>,
) => Promise<{ handle: string; order: StandardOrderRecord; replay: boolean }>;

const driver = expect.stringMatching(/^standard-request-[0-9a-f-]{36}$/u);

// 2026-08-22: a purchase request drove its order through the release
// finality wait without a lease; the recovery worker leased the order from
// underneath it (fence bump), and the request's RELEASE_FINAL transition
// died with ORDER_TRANSITION_CONFLICT: a 5xx for a captured payment that
// recovery then fulfilled anyway.
describe("in-flight purchase lease", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function driverHarness(overrides: Record<string, unknown> = {}) {
    const claimed = { orderId: "order-1", state: "ATTEMPT_OPENED", leaseFence: 3 } as StandardOrderRecord;
    const leased = { ...claimed, leaseFence: 4 };
    const store = {
      leaseOrder: vi.fn<() => Promise<StandardOrderRecord | null>>(async () => leased),
      renewLease: vi.fn(async () => true),
      releaseLease: vi.fn(async () => undefined),
      findById: vi.fn(async () => ({ ...leased, state: "DISPATCHED" })),
    };
    const incidents = { record: vi.fn(async () => undefined) };
    const service = harness({ railConfig: { leaseSeconds: 45 }, store, incidents, ...overrides });
    const drive = (service as unknown as { driveClaimedOrder: Drive }).driveClaimedOrder.bind(service);
    return { claimed, leased, store, incidents, drive };
  }

  it("leases the claimed order, renews the lease while driving, and releases it on success", async () => {
    const { claimed, leased, store, incidents, drive } = driverHarness();
    let finish!: (order: StandardOrderRecord) => void;
    const work = vi.fn(() => new Promise<StandardOrderRecord>((resolve) => { finish = resolve; }));

    const pending = drive("handle-1", claimed, work);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.leaseOrder).toHaveBeenCalledWith("order-1", driver, 45);
    expect(work).toHaveBeenCalledWith(leased);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.renewLease).toHaveBeenCalledTimes(1);
    expect(store.renewLease).toHaveBeenCalledWith("order-1", driver, 4, 45);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.renewLease).toHaveBeenCalledTimes(2);

    finish({ ...leased, state: "DISPATCHED" });
    await expect(pending).resolves.toEqual({
      handle: "handle-1", order: { ...leased, state: "DISPATCHED" }, replay: false,
    });
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", driver, 4);
    expect(incidents.record).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.renewLease).toHaveBeenCalledTimes(2);
  });

  it("answers a fenced-out transition with the current order state instead of failing", async () => {
    const { claimed, leased, store, incidents, drive } = driverHarness();
    let fail!: (error: Error) => void;
    const work = vi.fn(() => new Promise<StandardOrderRecord>((_, reject) => { fail = reject; }));

    const pending = drive("handle-1", claimed, work);
    await vi.advanceTimersByTimeAsync(15_000);
    fail(new Error("ORDER_TRANSITION_CONFLICT"));

    await expect(pending).resolves.toEqual({
      handle: "handle-1", order: { ...leased, state: "DISPATCHED" }, replay: false,
    });
    expect(store.findById).toHaveBeenCalledWith("order-1");
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", driver, 4);
    expect(incidents.record).toHaveBeenCalledWith({
      kind: "in_flight_purchase_fenced_out",
      orderId: "order-1",
      state: "DISPATCHED",
      details: { driver, fence: 4 },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.renewLease).toHaveBeenCalledTimes(1);
  });

  it("stops renewing once the fence has moved on", async () => {
    const { claimed, store, drive } = driverHarness();
    store.renewLease.mockResolvedValueOnce(false);
    let finish!: (order: StandardOrderRecord) => void;
    const work = vi.fn(() => new Promise<StandardOrderRecord>((resolve) => { finish = resolve; }));

    const pending = drive("handle-1", claimed, work);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(store.renewLease).toHaveBeenCalledTimes(1);
    finish({ ...claimed, leaseFence: 4, state: "DISPATCHED" });
    await pending;
  });

  it("rethrows other failures and still hands the lease back", async () => {
    const { claimed, store, incidents, drive } = driverHarness();
    const work = vi.fn(async () => { throw new Error("PROVIDER_DISPATCH_REJECTED"); });

    await expect(drive("handle-1", claimed, work)).rejects.toThrow("PROVIDER_DISPATCH_REJECTED");
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", driver, 4);
    expect(incidents.record).not.toHaveBeenCalled();
  });

  it("does not drive an order another driver already holds", async () => {
    const { claimed, store, drive } = driverHarness();
    store.leaseOrder.mockResolvedValueOnce(null);
    const work = vi.fn();

    await expect(drive("handle-1", claimed, work)).resolves.toMatchObject({
      handle: "handle-1", order: { state: "DISPATCHED" }, replay: false,
    });
    expect(work).not.toHaveBeenCalled();
    expect(store.releaseLease).not.toHaveBeenCalled();
  });
});

describe("recovery worker lease hand-back", () => {
  function worker(order: StandardOrderRecord, resumePaid = vi.fn(async () => undefined)) {
    const store = {
      leaseRecoverable: vi.fn<() => Promise<StandardOrderRecord | null>>()
        .mockResolvedValueOnce(order).mockResolvedValue(null),
      releaseLease: vi.fn(async () => undefined),
      transition: vi.fn(),
    };
    const instance = new StandardRailRecoveryWorker({
      config: { leaseSeconds: 45, recoveryIntervalMs: 10_000 } as StandardRailConfig,
      store: store as unknown as StandardRailStore,
      resumePaid,
      cleanup: vi.fn(async () => undefined),
    });
    const runBatch = (instance as unknown as { runBatch(): Promise<void> }).runBatch.bind(instance);
    return { store, resumePaid, runBatch };
  }

  const paidOrder = (updatedAt: Date) => ({
    orderId: "order-1",
    state: "DEPOSIT_FINAL",
    leaseFence: 9,
    listing: { deadlinePolicy: { fulfillmentSeconds: 300 } },
    updatedAt,
  } as unknown as StandardOrderRecord);

  const workerId = expect.stringMatching(/^standard-recovery-/u);

  it("releases its lease after recovering a due order so the cadence is unchanged", async () => {
    const { store, resumePaid, runBatch } = worker(paidOrder(new Date(Date.now() - 60_000)));
    await runBatch();
    expect(resumePaid).toHaveBeenCalledOnce();
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", workerId, 9);
    expect(store.leaseRecoverable).toHaveBeenLastCalledWith(expect.any(String), 45, []);
  });

  it("skips and releases an order that is not due yet", async () => {
    const { store, resumePaid, runBatch } = worker(paidOrder(new Date()));
    await runBatch();
    expect(resumePaid).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", workerId, 9);
    expect(store.leaseRecoverable).toHaveBeenLastCalledWith(expect.any(String), 45, ["order-1"]);
  });

  it("skips and releases an order whose recovery failed", async () => {
    const resumePaid = vi.fn(async () => { throw new Error("Settlement authorization is not final"); });
    const { store, runBatch } = worker(paidOrder(new Date(Date.now() - 60_000)), resumePaid);
    await runBatch();
    expect(store.releaseLease).toHaveBeenCalledWith("order-1", workerId, 9);
    expect(store.leaseRecoverable).toHaveBeenLastCalledWith(expect.any(String), 45, ["order-1"]);
  });
});

describe("store lease statements", () => {
  function storeWith(rows: Record<string, unknown>[] = []) {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql: sql.trim().replace(/\s+/g, " "), values });
      return { rows, rowCount: rows.length };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query } as unknown as Pool;
    return { store: new StandardRailStore(pool), calls };
  }

  it("keeps a live lease with the driver across a transition and still fences on lease_fence", async () => {
    const { store, calls } = storeWith([{
      order_id: "order-1", order_key: Buffer.alloc(32), order_handle: "handle-1", handle_hash: Buffer.alloc(32),
      state: "RELEASE_FINAL", provider_agent_id: "7", outcome_id: "outcome", binding_profile: "stock-fixed-v1",
      listing_manifest_hash: Buffer.alloc(32), provider_offer_hash: Buffer.alloc(32), canonical_listing: {},
      quote_hash: Buffer.alloc(32), canonical_quote: {}, canonical_request_hash: Buffer.alloc(32),
      canonical_request: {}, order_nonce: Buffer.alloc(32), authorization_key: null, payment_payload_hash: null,
      payer: null, gross_amount: "1", provider_net_amount: null, daski_commission_amount: null,
      encrypted_payment_payload: null, settlement_tx_hash: null, deposit_evidence_hash: null,
      release_tx_hash: null, release_evidence_hash: null, provider_task_id: null, rail_epoch: "1",
      version: "5", lease_fence: "4", expires_at: new Date(), created_at: new Date(), updated_at: new Date(),
    }]);
    const order = { orderId: "order-1", state: "DEPOSIT_FINAL", version: 4, leaseFence: 4 } as StandardOrderRecord;

    await expect(store.transition(order, "RELEASE_FINAL", "release_evidence_final"))
      .resolves.toMatchObject({ state: "RELEASE_FINAL", leaseFence: 4 });
    const update = calls.find(({ sql }) => sql.startsWith("UPDATE standard_orders SET"));
    expect(update?.sql).toContain("lease_owner=CASE WHEN lease_until>now() THEN lease_owner END");
    expect(update?.sql).toContain("lease_until=CASE WHEN lease_until>now() THEN lease_until END");
    expect(update?.sql).not.toContain("lease_owner=NULL");
    expect(update?.sql).toMatch(/WHERE order_id=\$\d+ AND version=\$\d+ AND state=\$\d+ AND lease_fence=\$\d+/u);
    expect(update?.values?.slice(-4)).toEqual(["order-1", 4, "DEPOSIT_FINAL", 4]);
  });

  it("only leases an unattended order and bumps the fence for the driver", async () => {
    const { store, calls } = storeWith();
    await expect(store.leaseOrder("order-1", "standard-request-a", 45)).resolves.toBeNull();
    expect(calls[0]?.sql).toContain("lease_fence=lease_fence+1");
    expect(calls[0]?.sql).toContain("WHERE order_id=$1 AND (lease_until IS NULL OR lease_until < now())");
    expect(calls[0]?.values).toEqual(["order-1", "standard-request-a", 45]);
  });

  it("renews only a lease the caller still holds", async () => {
    const { store, calls } = storeWith();
    await expect(store.renewLease("order-1", "standard-request-a", 4, 45)).resolves.toBe(false);
    expect(calls[0]?.sql).toContain("WHERE order_id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>now()");
    expect(calls[0]?.values).toEqual(["order-1", "standard-request-a", 4, 45]);
  });
});
