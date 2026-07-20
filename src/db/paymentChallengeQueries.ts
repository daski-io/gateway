import type { Hex, StoredChallenge } from "../types.js";
import type { Pool } from "./pool.js";
import {
  hexToBytea,
  normalizeHex,
  rowToChallenge,
  type ChallengeRow,
} from "./paymentChallengeCodec.js";

export function createPaymentChallengeQueries(pool: Pool) {
  return {
    async insertChallenge(challenge: {
      serviceRef: Hex;
      providerTokenId: bigint;
      buyerTokenId: bigint;
      amount: bigint;
      skillId: string | null;
      serviceSlug: string;
      serviceVersion: string;
      serviceId: Hex;
      providerA2AUrl: string;
      walletAddress: Hex;
      expiresAt: Date;
      rail?: "daski" | "external";
      authNonce?: Hex | null;
      quoteId?: string | null;
      quoteSignature?: Hex | null;
      quoteExpiresAt?: Date | null;
      quoteRequestHash?: Hex | null;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO payment_challenges
           (service_ref, provider_token_id, buyer_token_id, amount, skill_id,
            service_slug, service_version, service_id,
            provider_a2a_url, wallet_address, expires_at, settlement_state, rail, auth_nonce,
            quote_id, quote_signature, quote_expires_at, quote_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $13,
                 $14, $15, $16, $17)`,
        [
          hexToBytea(challenge.serviceRef),
          challenge.providerTokenId.toString(),
          challenge.buyerTokenId.toString(),
          challenge.amount.toString(),
          challenge.skillId,
          challenge.serviceSlug,
          challenge.serviceVersion,
          hexToBytea(challenge.serviceId),
          challenge.providerA2AUrl,
          challenge.walletAddress.toLowerCase(),
          challenge.expiresAt,
          challenge.rail ?? "daski",
          challenge.authNonce ? challenge.authNonce.toLowerCase() : null,
          challenge.quoteId ?? null,
          challenge.quoteSignature ? challenge.quoteSignature.toLowerCase() : null,
          challenge.quoteExpiresAt ?? null,
          challenge.quoteRequestHash ? hexToBytea(challenge.quoteRequestHash) : null,
        ],
      );
    },

    async getChallengeByWalletAndNonce(
      walletAddress: Hex,
      authNonce: Hex,
    ): Promise<StoredChallenge | null> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges
          WHERE wallet_address = $1 AND auth_nonce = $2`,
        [walletAddress.toLowerCase(), authNonce.toLowerCase()],
      );
      return res.rows[0] ? rowToChallenge(res.rows[0]) : null;
    },

    async listUnresolvedExternalChallenges(limit = 20): Promise<StoredChallenge[]> {
      const result = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges
          WHERE rail = 'external'
            AND settlement_state IN (
              'pending', 'expired', 'external_settled', 'attribution_broadcast'
            )
            AND auth_nonce IS NOT NULL
            AND created_at < now() - interval '30 seconds'
          ORDER BY created_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(rowToChallenge);
    },

    async getChallengeByRef(serviceRef: Hex): Promise<StoredChallenge | null> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges WHERE service_ref = $1`,
        [hexToBytea(serviceRef)],
      );
      return res.rows[0] ? rowToChallenge(res.rows[0]) : null;
    },

    async getChallengeByTxHash(txHash: Hex): Promise<StoredChallenge | null> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges WHERE transaction_hash = $1`,
        [normalizeHex(txHash)],
      );
      return res.rows[0] ? rowToChallenge(res.rows[0]) : null;
    },

    async getChallengeByPaymentId(
      paymentId: bigint,
    ): Promise<StoredChallenge | null> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges WHERE payment_id = $1`,
        [paymentId.toString()],
      );
      return res.rows[0] ? rowToChallenge(res.rows[0]) : null;
    },

    async recordConfirmation(paymentId: bigint, attestationUid: Hex): Promise<void> {
      await pool.query(
        `UPDATE payment_challenges
            SET confirmation_attestation_uid = $1
          WHERE payment_id = $2`,
        [hexToBytea(attestationUid), paymentId.toString()],
      );
    },
  };
}
