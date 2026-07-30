import type { Hex, StoredChallenge } from "../types.js";
import type { Pool } from "./pool.js";
import type { PoolClient } from "pg";
import {
  hexToBytea,
  normalizeHex,
  rowToChallenge,
  type ChallengeRow,
} from "./paymentChallengeCodec.js";

export function createPaymentChallengeStateQueries(pool: Pool) {
  return {
    async listPendingSettlementChallenges(
      limit = 100,
    ): Promise<StoredChallenge[]> {
      const result = await pool.query<ChallengeRow>(
        `SELECT *
           FROM payment_challenges
         WHERE settlement_state IN (
            'settlement_prepared', 'settlement_broadcast'
          )
          ORDER BY created_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(rowToChallenge);
    },

    async recordChallengeTransactionPrepared(
      client: PoolClient,
      serviceRef: Hex,
      facilitatorTransactionId: string,
      transactionHash: Hex,
    ): Promise<boolean> {
      const res = await client.query(
        `UPDATE payment_challenges
            SET transaction_hash = $2,
                settlement_facilitator_transaction_id = $3,
                settlement_state = 'settlement_prepared'
          WHERE service_ref = $1
            AND settlement_state = 'pending'
            AND transaction_hash IS NULL`,
        [
          hexToBytea(serviceRef),
          normalizeHex(transactionHash),
          facilitatorTransactionId,
        ],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async recordChallengeTransactionBroadcast(
      client: PoolClient,
      serviceRef: Hex,
      facilitatorTransactionId: string,
      transactionHash: Hex,
    ): Promise<boolean> {
      const res = await client.query(
        `UPDATE payment_challenges
            SET transaction_hash = $1,
                settlement_state = 'settlement_broadcast'
          WHERE service_ref = $2
            AND settlement_facilitator_transaction_id = $3
            AND settlement_state IN (
              'settlement_prepared', 'settlement_broadcast'
            )
            AND transaction_hash = $1`,
        [
          normalizeHex(transactionHash),
          hexToBytea(serviceRef),
          facilitatorTransactionId,
        ],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async clearChallengePreparedTransaction(
      serviceRef: Hex,
      transactionHash: Hex,
      client?: PoolClient,
    ): Promise<boolean> {
      const res = await (client ?? pool).query(
        `UPDATE payment_challenges
            SET transaction_hash = NULL,
                settlement_facilitator_transaction_id = NULL,
                settlement_state = 'pending'
          WHERE service_ref = $1
            AND settlement_state IN (
              'settlement_prepared', 'settlement_broadcast'
            )
            AND transaction_hash = $2`,
        [hexToBytea(serviceRef), normalizeHex(transactionHash)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async recordChallengePaid(
      serviceRef: Hex,
      paymentId: bigint,
      txHash: Hex,
      buyerAgentId?: bigint,
      client?: PoolClient,
    ): Promise<boolean> {
      const setBuyer = buyerAgentId !== undefined;
      const res = await (client ?? pool).query(
        `UPDATE payment_challenges
            SET settlement_state = 'paid',
                payment_id = $1,
                transaction_hash = $2,
                verified_at = now()${
                  setBuyer ? ",\n                buyer_token_id = $4" : ""
                }
          WHERE service_ref = $3
            AND (
              settlement_state IN (
                'pending', 'settlement_prepared', 'settlement_broadcast',
                'expired'
              )
              OR (
                settlement_state = 'paid'
                AND payment_id = $1
                AND transaction_hash = $2
              )
            )`,
        setBuyer
          ? [
              paymentId.toString(),
              normalizeHex(txHash),
              hexToBytea(serviceRef),
              (buyerAgentId as bigint).toString(),
            ]
          : [
              paymentId.toString(),
              normalizeHex(txHash),
              hexToBytea(serviceRef),
            ],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async expireStaleChallenges(): Promise<number> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET settlement_state = 'expired'
          WHERE settlement_state = 'pending'
            AND expires_at < now()
        `,
      );
      return res.rowCount ?? 0;
    },

    async deleteExpiredChallenges(
      retentionSeconds: number,
      batchSize = 500,
    ): Promise<number> {
      const res = await pool.query(
        `WITH candidates AS (
           SELECT service_ref
             FROM payment_challenges
            WHERE settlement_state = 'expired'
              AND expires_at < now() - ($1 * interval '1 second')
            ORDER BY expires_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM payment_challenges AS challenge
          USING candidates
          WHERE challenge.service_ref = candidates.service_ref`,
        [retentionSeconds, batchSize],
      );
      return res.rowCount ?? 0;
    },
  };
}
