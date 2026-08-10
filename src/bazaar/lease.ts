import type { Hex } from "../types.js";
import type { BazaarOrderStore } from "./store.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export async function withBazaarLease<T>(input: {
  store: BazaarOrderStore;
  orderRecordId: Hex;
  leaseToken: string;
  action: () => Promise<T>;
}): Promise<T> {
  let renewal = Promise.resolve();
  const interval = setInterval(() => {
    renewal = renewal
      .then(() => input.store.renewLease(input.orderRecordId, input.leaseToken))
      .then(() => undefined)
      .catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  interval.unref();
  try {
    return await input.action();
  } finally {
    clearInterval(interval);
    await renewal;
  }
}
