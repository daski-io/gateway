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
