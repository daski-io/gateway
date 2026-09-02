import type { Address } from "viem";
import { withAdvisoryLock } from "../db/advisoryLock.js";
import type { Pool } from "../db/pool.js";

/**
 * A relayer transaction plus its finality wait runs well under a minute on
 * Base; a waiter that cannot take the nonce within this window hands the
 * order back to recovery instead of sitting on the lock queue.
 */
export const FACILITATOR_NONCE_LOCK_WAIT_MS = 90_000;

export interface FacilitatorNonceLock {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const unlockedFacilitatorNonceLock: FacilitatorNonceLock = {
  run: (work) => work(),
};

export class PostgresFacilitatorNonceLock implements FacilitatorNonceLock {
  private readonly lockKey: string;

  constructor(
    private readonly pool: Pool,
    chainId: number,
    address: Address,
    private readonly waitMs: number = FACILITATOR_NONCE_LOCK_WAIT_MS,
  ) {
    this.lockKey =
      `standard:facilitator-nonce:${chainId}:${address.toLowerCase()}`;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return withAdvisoryLock(this.pool, this.lockKey, work, { waitMs: this.waitMs });
  }
}
