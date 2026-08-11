import { describe, expect, it } from "vitest";
import {
  BazaarLeaseOwnershipLostError,
  withBazaarLease,
} from "../src/bazaar/lease.js";
import type { Hex } from "../src/types.js";
import { callBazaarAdapter } from "../src/bazaar/adapterCall.js";

const ORDER_ID = `0x${"11".repeat(32)}` as Hex;

describe("Bazaar fenced lease heartbeat", () => {
  it("aborts work and runs cleanup when renewal returns false", async () => {
    let cleanupCalls = 0;
    let postLossEgress = false;
    const result = await withBazaarLease({
      store: { renewLease: async () => false },
      orderRecordId: ORDER_ID,
      leaseToken: "lease-1",
      heartbeatIntervalMs: 5,
      onOwnershipLost: () => "lost",
      onOwnershipLostCleanup: () => { cleanupCalls += 1; },
      action: async (guard) => {
        await aborted(guard.signal);
        try {
          guard.assertOwned();
          postLossEgress = true;
        } catch (error) {
          expect(error).toBeInstanceOf(BazaarLeaseOwnershipLostError);
          throw error;
        }
        return "unsafe";
      },
    });
    expect(result).toBe("lost");
    expect(cleanupCalls).toBe(1);
    expect(postLossEgress).toBe(false);
  });

  it("fails closed when the heartbeat query throws", async () => {
    const result = await withBazaarLease({
      store: { renewLease: async () => { throw new Error("database unavailable"); } },
      orderRecordId: ORDER_ID,
      leaseToken: "lease-2",
      heartbeatIntervalMs: 5,
      onOwnershipLost: () => "lost",
      action: async (guard) => {
        await aborted(guard.signal);
        guard.assertOwned();
        return "unsafe";
      },
    });
    expect(result).toBe("lost");
  });

  it("waits for an in-flight renewal before returning an action result", async () => {
    let startRenewal!: () => void;
    const renewalStarted = new Promise<void>((resolve) => { startRenewal = resolve; });
    let finishRenewal!: (renewed: boolean) => void;
    const renewalResult = new Promise<boolean>((resolve) => { finishRenewal = resolve; });
    let returned = false;
    const operation = withBazaarLease({
      store: {
        renewLease: async () => {
          startRenewal();
          return renewalResult;
        },
      },
      orderRecordId: ORDER_ID,
      leaseToken: "lease-in-flight",
      heartbeatIntervalMs: 1,
      onOwnershipLost: () => "lost",
      action: async () => {
        await renewalStarted;
        return "unsafe";
      },
    }).then((result) => {
      returned = true;
      return result;
    });
    await renewalStarted;
    await Promise.resolve();
    expect(returned).toBe(false);
    finishRenewal(false);
    expect(await operation).toBe("lost");
  });

  it("stops heartbeating after the owner completes its final transition", async () => {
    let renewals = 0;
    const result = await withBazaarLease({
      store: { renewLease: async () => { renewals += 1; return false; } },
      orderRecordId: ORDER_ID,
      leaseToken: "lease-3",
      heartbeatIntervalMs: 5,
      onOwnershipLost: () => "lost",
      action: async (guard) => {
        guard.complete();
        await new Promise((resolve) => setTimeout(resolve, 15));
        return "complete";
      },
    });
    expect(result).toBe("complete");
    expect(renewals).toBe(0);
  });
});

describe("Bazaar adapter deadline", () => {
  it("does not start an adapter after its parent signal is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let called = false;
    await expect(callBazaarAdapter({
      timeoutMs: 100,
      signal: controller.signal,
      operation: async () => {
        called = true;
        return "unsafe";
      },
    })).rejects.toThrow(/cancelled/);
    expect(called).toBe(false);
  });

  it("bounds an adapter that ignores cancellation", async () => {
    const startedAt = Date.now();
    await expect(callBazaarAdapter({
      timeoutMs: 100,
      operation: () => new Promise<string>(() => undefined),
    })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
