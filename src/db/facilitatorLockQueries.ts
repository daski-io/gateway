import type { Pool } from "./pool.js";
import type { Hex } from "../types.js";

export type FacilitatorTransactionOwner =
  | { kind: "settlement"; serviceRef: Hex }
  | { kind: "reputation"; paymentId: bigint };

export class FacilitatorOutboxPendingError extends Error {
  constructor() {
    super("a facilitator transaction is awaiting reconciliation");
    this.name = "FacilitatorOutboxPendingError";
  }
}

interface ReservationRow {
  kind: FacilitatorTransactionOwner["kind"];
  owner_key: string;
}

function ownsReservation(
  reservation: ReservationRow,
  owner: FacilitatorTransactionOwner | undefined,
): boolean {
  if (!owner || reservation.kind !== owner.kind) return false;
  const ownerKey =
    owner.kind === "settlement"
      ? owner.serviceRef.slice(2).toLowerCase()
      : owner.paymentId.toString();
  return reservation.owner_key.toLowerCase() === ownerKey;
}

/**
 * Serializes facilitator nonce allocation across replicas. The lock is
 * released by the write's onBroadcast callback, after any transaction hash
 * persistence, so chain confirmation waits never block the next nonce.
 */
export function createFacilitatorLockQueries(pool: Pool) {
  return {
    async withFacilitatorTransactionLock<T>(
      action: (release: () => Promise<void>) => Promise<T>,
      options: { owner?: FacilitatorTransactionOwner } = {},
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
          `SELECT kind, owner_key
             FROM (
               SELECT 'settlement'::text AS kind,
                      encode(service_ref, 'hex') AS owner_key,
                      prepared_at AS reserved_at
                 FROM payment_challenges
                WHERE settlement_state = 'settlement_prepared'
               UNION ALL
               SELECT 'reputation'::text AS kind,
                      payment_id::text AS owner_key,
                      prepared_at AS reserved_at
                 FROM reputation_mirrors
                WHERE prepared_tx IS NOT NULL
                  AND tx_nonce IS NOT NULL
                  AND tx_hash IS NOT NULL
                  AND broadcast_at IS NULL
             ) AS reservations
            ORDER BY reserved_at, kind, owner_key
            LIMIT 2`,
        );
        if (
          pending.rows.length > 1 ||
          (pending.rows[0] &&
            !ownsReservation(pending.rows[0], options.owner))
        ) {
          throw new FacilitatorOutboxPendingError();
        }
        return await action(release);
      } finally {
        await release();
      }
    },
  };
}
