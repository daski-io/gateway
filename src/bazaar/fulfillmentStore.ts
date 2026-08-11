import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import { completeBazaarFulfillment } from "./fulfillmentCompletionStore.js";
import type { VerifiedBazaarFulfillmentAttestation } from "./fulfillmentAttestation.js";
import {
  claimBazaarFulfillment,
  deferBazaarFulfillment,
  renewBazaarFulfillmentLease,
  type BazaarFulfillmentWorkItem,
} from "./fulfillmentLeaseStore.js";

export class BazaarFulfillmentStore {
  constructor(private readonly pool: Pool) {}

  claim(leaseOwner: string): Promise<BazaarFulfillmentWorkItem | null> {
    return claimBazaarFulfillment({ pool: this.pool, leaseOwner });
  }

  renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    return renewBazaarFulfillmentLease(this.pool, orderRecordId, leaseToken);
  }

  defer(
    orderRecordId: Hex,
    leaseToken: string,
    retryDelaySeconds: number,
  ): Promise<boolean> {
    return deferBazaarFulfillment({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      retryDelaySeconds,
    });
  }

  complete(
    work: BazaarFulfillmentWorkItem,
    attestation: VerifiedBazaarFulfillmentAttestation,
  ): Promise<boolean> {
    return completeBazaarFulfillment({ pool: this.pool, work, attestation });
  }
}
