import type { Hex } from "../types.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

interface BazaarLeaseStore {
  renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean>;
}

export class BazaarLeaseGuard {
  private readonly controller = new AbortController();
  private lost = false;
  private completed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get ownershipLost(): boolean {
    return this.lost;
  }

  assertOwned(): void {
    if (this.lost) throw new BazaarLeaseOwnershipLostError();
  }

  complete(): void {
    this.completed = true;
  }

  loseOwnership(): boolean {
    if (this.completed || this.lost) return false;
    this.lost = true;
    this.controller.abort(new BazaarLeaseOwnershipLostError());
    return true;
  }

  canHeartbeat(): boolean {
    return !this.completed && !this.lost;
  }
}

export class BazaarLeaseOwnershipLostError extends Error {
  constructor() {
    super("Bazaar processing lease ownership was lost");
  }
}

export async function withBazaarLease<T>(input: {
  store: BazaarLeaseStore;
  orderRecordId: Hex;
  leaseToken: string;
  action: (guard: BazaarLeaseGuard) => Promise<T>;
  onOwnershipLost: () => Promise<T> | T;
  onOwnershipLostCleanup?: () => void;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const guard = new BazaarLeaseGuard();
  let renewal = Promise.resolve();
  const loseOwnership = () => {
    if (guard.loseOwnership()) input.onOwnershipLostCleanup?.();
  };
  const onAbort = () => loseOwnership();
  if (input.signal) {
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();
  }
  const interval = setInterval(() => {
    if (!guard.canHeartbeat()) return;
    renewal = renewal
      .then(async () => {
        if (!guard.canHeartbeat()) return;
        try {
          const renewed = await input.store.renewLease(
            input.orderRecordId,
            input.leaseToken,
          );
          if (!renewed) loseOwnership();
        } catch {
          loseOwnership();
        }
      });
  }, input.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  interval.unref();
  try {
    if (guard.ownershipLost) return await input.onOwnershipLost();
    const result = await input.action(guard);
    clearInterval(interval);
    await renewal;
    return guard.ownershipLost ? await input.onOwnershipLost() : result;
  } catch (error) {
    clearInterval(interval);
    await renewal;
    if (guard.ownershipLost || error instanceof BazaarLeaseOwnershipLostError) {
      return input.onOwnershipLost();
    }
    throw error;
  } finally {
    clearInterval(interval);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
