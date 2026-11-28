import { afterEach, describe, expect, it, vi } from "vitest";
import { StandardRailRecoveryWorker } from "../src/standardRail/recovery.js";
import type { StandardOrderRecord } from "../src/standardRail/types.js";

const order = (orderId: string, state: string) =>
  ({ orderId, state, updatedAt: new Date(0), leaseFence: 1 }) as unknown as StandardOrderRecord;

afterEach(() => { vi.useRealTimers(); });

describe("recovery lanes", () => {
  it("settles a verified authorization on its own lane while the main batch waits on a provider", async () => {
    vi.useFakeTimers();
    const dispatched = order("dispatched", "DISPATCHED");
    const verified = order("verified", "VERIFIED");
    let answerProvider: () => void = () => undefined;
    const provider = new Promise<void>((resolve) => { answerProvider = resolve; });
    const lanes: string[] = [];
    const store = {
      leaseRecoverable: vi.fn(async (_worker: string, _lease: number, skipped: string[], lane: string) => {
        lanes.push(lane);
        const due = lane === "settlement" ? [verified] : [dispatched, verified];
        return due.find((candidate) => !skipped.includes(candidate.orderId)) ?? null;
      }),
      releaseLease: vi.fn(async () => undefined),
      renewLease: vi.fn(async () => true),
    };
    const recovered: string[] = [];
    const resumePaid = vi.fn(async (value: StandardOrderRecord) => {
      recovered.push(value.orderId);
      if (value.orderId === "dispatched") await provider;
    });
    const worker = new StandardRailRecoveryWorker({
      config: { recoveryIntervalMs: 10_000, leaseSeconds: 45 } as never,
      store: store as never,
      listing: async () => ({ deadlinePolicy: { fulfillmentSeconds: 30 } }) as never,
      resumePaid,
      cleanup: async () => undefined,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(50);
    // The main batch is still waiting on the provider; the verified order did not wait for it.
    expect([...recovered].sort()).toEqual(["dispatched", "verified"]);
    expect(lanes).toContain("settlement");
    answerProvider();
    await worker.stop();
  });
});

describe("recovery lease", () => {
  function harness(lane: "all" | "settlement", visit: () => Promise<void>, renewLease = vi.fn(async () => true)) {
    const ambiguous = order("ambiguous", "SETTLEMENT_AMBIGUOUS");
    const owners: string[] = [];
    let leased = false;
    const store = {
      leaseRecoverable: vi.fn(async (worker: string, _lease: number, skipped: string[], from: string) => {
        if (from !== lane || leased || skipped.includes("ambiguous")) return null;
        leased = true;
        owners.push(worker);
        return ambiguous;
      }),
      releaseLease: vi.fn(async () => undefined),
      renewLease,
    };
    const worker = new StandardRailRecoveryWorker({
      config: { recoveryIntervalMs: 600_000, leaseSeconds: 45 } as never,
      store: store as never,
      listing: async () => ({ deadlinePolicy: { fulfillmentSeconds: 30 } }) as never,
      resumePaid: vi.fn(visit),
      cleanup: async () => undefined,
    });
    return { worker, store, owners };
  }

  for (const lane of ["all", "settlement"] as const) {
    it(`renews the lease of the order the ${lane} lane holds while a visit outlasts it, as that lane's owner`, async () => {
      vi.useFakeTimers();
      let finishVisit: () => void = () => undefined;
      const visit = new Promise<void>((resolve) => { finishVisit = resolve; });
      const { worker, store, owners } = harness(lane, () => visit);
      worker.start();
      // A 100-second visit against a 45-second lease: renewed every 15 seconds.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(store.renewLease).toHaveBeenCalledTimes(6);
      expect(store.renewLease).toHaveBeenCalledWith("ambiguous", owners[0], 1, 45);
      finishVisit();
      await vi.advanceTimersByTimeAsync(1);
      const renewed = store.renewLease.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.renewLease.mock.calls.length).toBe(renewed);
      expect(store.releaseLease).toHaveBeenCalledWith("ambiguous", owners[0], 1);
      await worker.stop();
    });
  }

  it("stops renewing once the lease is lost or the visit throws", async () => {
    vi.useFakeTimers();
    const lost = harness("all", () => new Promise<void>(() => undefined), vi.fn(async () => false));
    lost.worker.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(lost.store.renewLease).toHaveBeenCalledTimes(1);
    void lost.worker.stop();

    const failing = harness("all", async () => { await new Promise((resolve) => setTimeout(resolve, 20_000)); throw new Error("rpc down"); });
    failing.worker.start();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(failing.store.renewLease).toHaveBeenCalledTimes(1);
    expect(failing.store.releaseLease).toHaveBeenCalledOnce();
    await failing.worker.stop();
  });
});
