import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import {
  completeBazaarNoTransfer,
  completeBazaarObservedTransfer,
} from "./observationCompletionStore.js";
import {
  claimBazaarObservation,
  deferBazaarObservation,
  renewBazaarObservationLease,
  type LeasedBazaarObservation,
} from "./observationLeaseStore.js";
import type {
  BazaarObservationOriginState,
  BazaarOrderState,
  BazaarRefundReason,
  BazaarSettlementObservationPolicy,
  BazaarSettlementObservationResult,
} from "./types.js";

type NoTransferResult = Extract<
  BazaarSettlementObservationResult,
  { kind: "no_transfer" }
>;
type MatchingTransferResult = Extract<
  BazaarSettlementObservationResult,
  { kind: "matching_transfer" }
>;
type NoTransferState = Extract<BazaarOrderState,
  "rejected_expired_no_transfer" | "ambiguous_expired_no_transfer" |
  "invalid_evidence_expired_no_transfer">;

export class BazaarObservationStore {
  constructor(private readonly pool: Pool) {}

  claim(
    leaseOwner: string,
    nowSeconds: bigint,
    policy: BazaarSettlementObservationPolicy,
  ): Promise<LeasedBazaarObservation | null> {
    return claimBazaarObservation({
      pool: this.pool,
      leaseOwner,
      nowSeconds,
      finalityWindowSeconds: policy.finalityWindowSeconds,
    });
  }

  renewLease(orderRecordId: Hex, leaseToken: string): Promise<boolean> {
    return renewBazaarObservationLease(this.pool, orderRecordId, leaseToken);
  }

  defer(
    orderRecordId: Hex,
    leaseToken: string,
    retryDelaySeconds: number,
  ): Promise<boolean> {
    return deferBazaarObservation({
      pool: this.pool,
      orderRecordId,
      leaseToken,
      retryDelaySeconds,
    });
  }

  completeNoTransfer(input: {
    orderRecordId: Hex;
    originState: BazaarObservationOriginState;
    terminalState: NoTransferState;
    leaseToken: string;
    observation: NoTransferResult;
  }): Promise<boolean> {
    return completeBazaarNoTransfer({ ...input, pool: this.pool });
  }

  completeObservedTransfer(input: {
    orderRecordId: Hex;
    originState: BazaarObservationOriginState;
    leaseToken: string;
    observation: MatchingTransferResult;
  } & (
    | { disposition: "unapproved" }
    | {
        disposition: "refund_due";
        reason: Extract<BazaarRefundReason,
          "AMBIGUOUS_PAID" | "SETTLEMENT_EVIDENCE_INVALID">;
      }
  )): Promise<boolean> {
    return completeBazaarObservedTransfer({ ...input, pool: this.pool });
  }
}
