import { withBazaarLease } from "./lease.js";
import { observeBazaarFulfillment } from "./fulfillmentAttestation.js";
import type { BazaarFulfillmentStore } from "./fulfillmentStore.js";
import type { BazaarCompatibilityWiring } from "./types.js";

const MAX_FULFILLMENTS_PER_RUN = 50;

export class BazaarFulfillmentRecovery {
  constructor(
    private readonly store: BazaarFulfillmentStore,
    private readonly wiring: BazaarCompatibilityWiring,
    private readonly owner: string,
    private readonly shutdownSignal?: AbortSignal,
  ) {}

  async runOnce(): Promise<void> {
    for (let processed = 0; processed < MAX_FULFILLMENTS_PER_RUN; processed += 1) {
      if (this.shutdownSignal?.aborted) return;
      const work = await this.store.claim(this.owner);
      if (!work) return;
      await withBazaarLease({
        store: this.store,
        orderRecordId: work.orderRecordId,
        leaseToken: work.leaseToken,
        action: async (lease) => {
          const attestation = await observeBazaarFulfillment({
            work,
            wiring: this.wiring,
            lease,
          });
          if (attestation === "pending") {
            const deferred = await this.store.defer(
              work.orderRecordId,
              work.leaseToken,
              this.wiring.fulfillmentObservationPolicy.retryDelaySeconds,
            );
            if (deferred) lease.complete();
            return;
          }
          const completed = await this.store.complete(work, attestation);
          if (completed) lease.complete();
        },
        onOwnershipLost: () => undefined,
        signal: this.shutdownSignal,
      });
    }
  }
}
