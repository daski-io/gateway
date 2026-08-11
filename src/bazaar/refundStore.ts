import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import {
  finalizeBazaarRefund,
  markBazaarRefundBlocked,
  recordBazaarRefundBroadcast,
} from "./refundCompletionStore.js";
import {
  claimBazaarRefund,
  deferBazaarRefund,
  renewBazaarRefundLease,
  type BazaarRefundWorkItem,
} from "./refundLeaseStore.js";

export class BazaarRefundStore {
  constructor(private readonly pool: Pool) {}

  claim(leaseOwner: string): Promise<BazaarRefundWorkItem | null> {
    return claimBazaarRefund({ pool: this.pool, leaseOwner });
  }

  renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    return renewBazaarRefundLease(this.pool, orderRecordId, leaseToken);
  }

  defer(
    orderRecordId: Hex,
    leaseToken: string,
    retryDelaySeconds: number,
  ): Promise<boolean> {
    return deferBazaarRefund({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      retryDelaySeconds,
    });
  }

  recordBroadcast(
    orderRecordId: Hex,
    leaseToken: string,
    transaction: Hex,
  ): Promise<boolean> {
    return recordBazaarRefundBroadcast({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      transaction,
    });
  }

  markBlocked(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    return markBazaarRefundBlocked({ pool: this.pool, orderRecordId, leaseToken });
  }

  finalize(input: {
    orderRecordId: Hex;
    leaseToken: string;
    evidenceHash: Hex;
    blockHash: Hex;
    transferLogIndex: number;
  }): Promise<boolean> {
    return finalizeBazaarRefund({ pool: this.pool, ...input });
  }
}
