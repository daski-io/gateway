import type { Address } from "viem";
import type { Pool } from "../db/pool.js";

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
  ) {
    this.lockKey =
      `standard:facilitator-nonce:${chainId}:${address.toLowerCase()}`;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended($1,0))",
        [this.lockKey],
      );
      locked = true;
      return await work();
    } finally {
      if (locked) {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [this.lockKey],
        ).catch(() => undefined);
      }
      client.release();
    }
  }
}
