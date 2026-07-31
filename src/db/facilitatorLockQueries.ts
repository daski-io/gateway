import type { PoolClient } from "pg";
import type { Pool } from "./pool.js";
import type { FacilitatorOperationOwner } from "./facilitatorTransactionTypes.js";

export class FacilitatorTransactionPendingError extends Error {
  constructor() {
    super("a facilitator transaction is awaiting reconciliation");
    this.name = "FacilitatorTransactionPendingError";
  }
}

interface ReservationRow {
  kind: FacilitatorOperationOwner["kind"];
  owner_key: string;
}

function ownsReservation(
  reservation: ReservationRow,
  owner: FacilitatorOperationOwner | undefined,
): boolean {
  if (!owner || reservation.kind !== owner.kind) return false;
  return reservation.owner_key === owner.key;
}

/**
 * Serializes facilitator nonce allocation across replicas. The action may
 * release after the durable broadcast transition so receipt waits do not
 * serialize later nonce allocation.
 */
export function createFacilitatorLockQueries(pool: Pool) {
  return {
    async withFacilitatorTransactionLock<T>(
      action: (
        release: () => Promise<void>,
        client: PoolClient,
      ) => Promise<T>,
      options: { owner?: FacilitatorOperationOwner } = {},
    ): Promise<T> {
      const client = await pool.connect();
      const lockName = "daski:facilitator-wallet";
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
            [lockName],
          );
        } finally {
          client.release();
        }
      };
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          lockName,
        ]);
        const pending = await client.query<ReservationRow>(
          `SELECT operation_kind AS kind, operation_key AS owner_key
             FROM facilitator_transactions
            WHERE status = 'prepared'
            ORDER BY prepared_at, operation_kind, operation_key
            LIMIT 2`,
        );
        if (
          pending.rows.length > 1 ||
          (pending.rows[0] &&
            !ownsReservation(pending.rows[0], options.owner))
        ) {
          throw new FacilitatorTransactionPendingError();
        }
        return await action(release, client);
      } finally {
        await release();
      }
    },
  };
}
