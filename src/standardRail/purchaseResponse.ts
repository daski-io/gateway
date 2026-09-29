import { asStandardRailError } from "./errors.js";
import type { StandardOrderRecord } from "./types.js";
import { logger } from "../util/logger.js";

// The budget begins after durable authorization capture, not during admission.
export const PURCHASE_RESPONSE_WAIT_MS = 5_000;

export interface PurchaseReply {
  handle: string;
  order: StandardOrderRecord;
  replay: boolean;
}

/** Tracks driver lifetime for shutdown only. The database owns all execution
 * exclusion, leases, fencing, and payment/dispatch idempotency. */
export class StandardPurchaseResponses {
  private readonly active = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    const lifetime = work.then(() => undefined, () => undefined);
    this.active.add(lifetime);
    void lifetime.then(() => this.active.delete(lifetime));
    return work;
  }

  async run(admitted: PurchaseReply, drive: () => Promise<PurchaseReply>): Promise<PurchaseReply> {
    let detached = false;
    const completed = Promise.resolve().then(drive).then(
      (reply) => ({ ok: true as const, reply }),
      (error: unknown) => {
        if (detached) {
          // Recovery uses the durable state. Never log the signed payload or
          // supplier error text, and never ask the buyer to authorize again.
          logger.warn("Admitted purchase driver stopped after its pending response", {
            orderId: admitted.order.orderId,
            code: asStandardRailError(error)?.code ?? "INTERNAL_ERROR",
          });
        }
        return { ok: false as const, error };
      },
    );
    this.track(completed);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        completed,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PURCHASE_RESPONSE_WAIT_MS);
        }),
      ]);
      if (result === null) {
        detached = true;
        // Return the durable admission snapshot without a database/chain read
        // after the deadline. It claims neither settlement nor dispatch; the
        // authorized status/replay paths return subsequent progress.
        return admitted;
      }
      if (!result.ok) throw result.error;
      return result.reply;
    } finally {
      clearTimeout(timer);
    }
  }

  async drain(): Promise<void> {
    // An admitted request may register its driver while shutdown waits for
    // admission. Include that new driver in the next drain pass.
    while (this.active.size) await Promise.all(this.active);
  }
}
