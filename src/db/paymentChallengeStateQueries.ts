import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import { hexToBytea, normalizeHex } from "./paymentChallengeCodec.js";

export function createPaymentChallengeStateQueries(pool: Pool) {
  return {
    async recordChallengeExternallySettled(
      serviceRef: Hex,
      externalSettleTx: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET external_settle_tx = $1,
                settlement_state = 'external_settled'
          WHERE service_ref = $2
            AND rail = 'external'
            AND settlement_state IN ('pending', 'expired', 'external_settled')
            AND (external_settle_tx IS NULL OR external_settle_tx = $1)`,
        [normalizeHex(externalSettleTx), hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async recordChallengeExternalAuthorizationConsumed(
      serviceRef: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET settlement_state = 'external_settled'
          WHERE service_ref = $1
            AND rail = 'external'
            AND settlement_state IN ('pending', 'expired', 'external_settled')`,
        [hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async recordChallengeTransactionBroadcast(
      serviceRef: Hex,
      transactionHash: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET transaction_hash = $1,
                settlement_state = 'attribution_broadcast'
          WHERE service_ref = $2
            AND settlement_state IN (
              'pending', 'external_settled', 'expired', 'attribution_broadcast'
            )
            AND (transaction_hash IS NULL OR transaction_hash = $1)`,
        [normalizeHex(transactionHash), hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async clearChallengeTransactionBroadcast(
      serviceRef: Hex,
      transactionHash: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET transaction_hash = NULL,
                settlement_state = CASE
                  WHEN rail = 'external' THEN 'external_settled'
                  ELSE 'pending'
                END
          WHERE service_ref = $1
            AND settlement_state = 'attribution_broadcast'
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
    ): Promise<boolean> {
      const setBuyer = buyerAgentId !== undefined;
      const res = await pool.query(
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
                'pending', 'external_settled', 'attribution_broadcast', 'expired'
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
          : [paymentId.toString(), normalizeHex(txHash), hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async expireStaleChallenges(): Promise<number> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET settlement_state = 'expired'
          WHERE settlement_state = 'pending'
            AND expires_at < now()
            AND external_settle_tx IS NULL`,
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
