import type {
  DaskiX402Declaration,
  Hex,
  PaymentRequired,
  SettlementResponse,
  StoredChallenge,
} from "../types.js";
import type { Pool } from "./pool.js";
import type { PoolClient } from "pg";
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
      expectedPayee?: Hex | null;
      expectedPayeeBlock?: bigint | null;
      providerA2AUrl: string;
      walletAddress: Hex;
      expiresAt: Date;
      quoteId?: string | null;
      quoteSignature?: Hex | null;
      quoteExpiresAt?: Date | null;
      quoteRequestHash?: Hex | null;
      paymentRequired?: PaymentRequired;
      requirementsHash?: Hex;
      resourceUrl?: string;
      daskiExtension?: DaskiX402Declaration;
      requestFingerprint?: Hex;
      registrationDelegation?: StoredChallenge["registrationDelegation"];
      providerAuthority: {
        walletAddress: Hex;
        agentURI: string;
        observedBlock: bigint;
      };
    }): Promise<void> {
      await pool.query(
        `INSERT INTO payment_challenges
           (service_ref, provider_token_id, buyer_token_id, amount, skill_id,
            service_slug, service_version, service_id,
            expected_payee, expected_payee_block,
            provider_a2a_url, wallet_address, expires_at, settlement_state,
            quote_id, quote_signature, quote_expires_at, quote_request_hash,
            x402_version, payment_required, requirements_hash, resource_url,
            daski_extension, request_fingerprint, registration_delegation,
            provider_authority_wallet, provider_authority_agent_uri,
            provider_authority_block)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending',
                 $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
                 $25, $26, $27)`,
        [
          hexToBytea(challenge.serviceRef),
          challenge.providerTokenId.toString(),
          challenge.buyerTokenId.toString(),
          challenge.amount.toString(),
          challenge.skillId,
          challenge.serviceSlug,
          challenge.serviceVersion,
          hexToBytea(challenge.serviceId),
          challenge.expectedPayee?.toLowerCase() ?? null,
          challenge.expectedPayeeBlock?.toString() ?? null,
          challenge.providerA2AUrl,
          challenge.walletAddress.toLowerCase(),
          challenge.expiresAt,
          challenge.quoteId ?? null,
          challenge.quoteSignature ? challenge.quoteSignature.toLowerCase() : null,
          challenge.quoteExpiresAt ?? null,
          challenge.quoteRequestHash ? hexToBytea(challenge.quoteRequestHash) : null,
          challenge.paymentRequired ? 2 : null,
          challenge.paymentRequired
            ? JSON.stringify(challenge.paymentRequired)
            : null,
          challenge.requirementsHash
            ? hexToBytea(challenge.requirementsHash)
            : null,
          challenge.resourceUrl ?? null,
          challenge.daskiExtension
            ? JSON.stringify(challenge.daskiExtension)
            : null,
          challenge.requestFingerprint
            ? hexToBytea(challenge.requestFingerprint)
            : null,
          challenge.registrationDelegation
            ? JSON.stringify(challenge.registrationDelegation)
            : null,
          challenge.providerAuthority.walletAddress.toLowerCase(),
          challenge.providerAuthority.agentURI,
          challenge.providerAuthority.observedBlock.toString(),
        ],
      );
    },

    async bindVerifiedPayment(input: {
      serviceRef: Hex;
      payer: Hex;
      nonce: Hex;
      payloadFingerprint: Hex;
      registrationDelegation?: StoredChallenge["registrationDelegation"];
    }): Promise<"bound" | "idempotent" | "conflict"> {
      let result;
      try {
        result = await pool.query<{
          accepted_payer: string | null;
          eip3009_nonce: Buffer | null;
          payment_payload_fingerprint: Buffer | null;
        }>(
          `UPDATE payment_challenges
            SET accepted_payer = $2,
                eip3009_nonce = $3,
                payment_payload_fingerprint = $4,
                registration_delegation =
                  COALESCE(registration_delegation, $5::jsonb)
          WHERE service_ref = $1
            AND x402_version = 2
            AND (
              accepted_payer IS NULL
              OR (
                accepted_payer = $2
                AND eip3009_nonce = $3
                AND payment_payload_fingerprint = $4
              )
            )
        RETURNING accepted_payer, eip3009_nonce, payment_payload_fingerprint`,
          [
            hexToBytea(input.serviceRef),
            input.payer.toLowerCase(),
            hexToBytea(input.nonce),
            hexToBytea(input.payloadFingerprint),
            input.registrationDelegation
              ? JSON.stringify(input.registrationDelegation)
              : null,
          ],
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "23505"
        ) {
          return "conflict";
        }
        throw error;
      }
      if (result.rowCount === 0) return "conflict";
      return "bound";
    },

    async recordSettleResponse(
      serviceRef: Hex,
      response: SettlementResponse,
    ): Promise<void> {
      await pool.query(
        `UPDATE payment_challenges
            SET settle_response = $2
          WHERE service_ref = $1`,
        [hexToBytea(serviceRef), JSON.stringify(response)],
      );
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

    async recordConfirmation(
      paymentId: bigint,
      attestationUid: Hex,
      client?: PoolClient,
    ): Promise<void> {
      await (client ?? pool).query(
        `UPDATE payment_challenges
            SET confirmation_attestation_uid = $1
          WHERE payment_id = $2`,
        [hexToBytea(attestationUid), paymentId.toString()],
      );
    },
  };
}
