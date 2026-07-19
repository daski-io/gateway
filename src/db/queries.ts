import type { Pool } from "./pool.js";
import type { Hex, StoredChallenge } from "../types.js";
import { createBuyerIdentityQueries } from "./buyerIdentityQueries.js";
import { createAggregateQueries } from "./aggregateQueries.js";
import { createChainEventQueries } from "./chainEventQueries.js";
import { createRateLimitQueries } from "./rateLimitQueries.js";
import { createReputationQueries } from "./reputationQueries.js";
import { createSkillQueries } from "./skillQueries.js";
export type { SkillSearchHit } from "./skillQueries.js";
export type { ChainActivityRow } from "./chainEventQueries.js";
export type { ReputationMirrorRow } from "./reputationQueries.js";

function hexToBytea(hex: Hex): Buffer {
  return Buffer.from(hex.slice(2), "hex");
}

function byteaToHex(buf: Buffer): Hex {
  return `0x${buf.toString("hex")}` as Hex;
}

function normalizeHex(hex: string): string {
  return hex.toLowerCase();
}

interface ChallengeRow {
  service_ref: Buffer;
  provider_token_id: string;
  buyer_token_id: string;
  amount: string;
  skill_id: string | null;
  service_slug: string | null;
  service_version: string | null;
  service_id: Buffer | null;
  provider_a2a_url: string;
  wallet_address: string;
  created_at: Date;
  expires_at: Date;
  status: "pending" | "paid" | "expired";
  payment_id: string | null;
  transaction_hash: string | null;
  verified_at: Date | null;
  confirmation_attestation_uid: Buffer | null;
  rail: "daski" | "external" | null;
  auth_nonce: string | null;
  external_settle_tx: string | null;
  quote_id: string | null;
  quote_signature: string | null;
  quote_expires_at: Date | null;
  quote_request_hash: Buffer | null;
}

function requiredColumn<T>(value: T | null, column: string): T {
  if (value === null) {
    throw new Error(`payment challenge is missing required column ${column}`);
  }
  return value;
}

function rowToChallenge(row: ChallengeRow): StoredChallenge {
  return {
    serviceRef: byteaToHex(row.service_ref),
    providerTokenId: BigInt(row.provider_token_id),
    buyerTokenId: BigInt(row.buyer_token_id),
    amount: BigInt(row.amount),
    skillId: row.skill_id ?? null,
    serviceSlug: requiredColumn(row.service_slug, "service_slug"),
    serviceVersion: requiredColumn(row.service_version, "service_version"),
    serviceId: byteaToHex(requiredColumn(row.service_id, "service_id")),
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: requiredColumn(
      row.wallet_address,
      "wallet_address",
    ) as Hex,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    paymentId: row.payment_id != null ? BigInt(row.payment_id) : null,
    transactionHash:
      row.transaction_hash != null ? (row.transaction_hash as Hex) : null,
    verifiedAt: row.verified_at,
    confirmationAttestationUid: row.confirmation_attestation_uid
      ? byteaToHex(row.confirmation_attestation_uid)
      : null,
    rail: requiredColumn(row.rail, "rail"),
    authNonce: row.auth_nonce != null ? (row.auth_nonce as Hex) : null,
    externalSettleTx:
      row.external_settle_tx != null ? (row.external_settle_tx as Hex) : null,
    quoteId: row.quote_id ?? null,
    quoteSignature:
      row.quote_signature != null ? (row.quote_signature as Hex) : null,
    quoteExpiresAt: row.quote_expires_at ?? null,
    quoteRequestHash: row.quote_request_hash
      ? byteaToHex(row.quote_request_hash)
      : null,
  };
}

export function createQueries(pool: Pool) {
  const settlementGates = new Map<string, Promise<void>>();

  return {
    ...createRateLimitQueries(pool),

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
      // External rail (Bazaar route): rail='external' plus the client's
      // EIP-3009 nonce. Omitted for the default gateway-settled flow.
      rail?: "daski" | "external";
      authNonce?: Hex | null;
      // Provider quote commitment backing this challenge (audit 1.1).
      // When set, serviceRef is the quote's commitment hash and these
      // credentials are forwarded as A2A metadata at task-submit time.
      quoteId?: string | null;
      quoteSignature?: Hex | null;
      quoteExpiresAt?: Date | null;
      quoteRequestHash?: Hex | null;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO payment_challenges
           (service_ref, provider_token_id, buyer_token_id, amount, skill_id,
            service_slug, service_version, service_id,
            provider_a2a_url, wallet_address, expires_at, status, rail, auth_nonce,
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
          challenge.quoteRequestHash
            ? hexToBytea(challenge.quoteRequestHash)
            : null,
        ],
      );
    },

    /**
     * External-rail idempotency lookup: resolve a challenge by the buyer
     * wallet + the client-chosen EIP-3009 nonce from the payment payload.
     * External x402 clients never learn Daski serviceRefs, so a paid retry
     * of the same signed payload can only be recognized by this pair
     * (unique per migration 008's partial index).
     */
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

    /**
     * Record the external facilitator's settle tx hash the moment it is
     * known — BEFORE the gateway submits the attribution tx. A crash
     * between the two leaves a row with external_settle_tx set, which the
     * paid-retry path reads as "funds already moved, go straight to
     * attribution". If the expiry sweep won the race first, recording the
     * successful external settle restores the row to pending.
     */
    async recordChallengeExternallySettled(
      serviceRef: Hex,
      externalSettleTx: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET external_settle_tx = $1,
                status = 'pending'
          WHERE service_ref = $2
            AND rail = 'external'
            AND status IN ('pending', 'expired')
            AND (external_settle_tx IS NULL OR external_settle_tx = $1)`,
        [normalizeHex(externalSettleTx), hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
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

    /**
     * Serializes settlement for one serviceRef across every gateway replica.
     * PostgreSQL session advisory locks release automatically if the
     * connection drops; the explicit unlock keeps pooled connections clean.
     */
    async withChallengeSettlementLock<T>(
      serviceRef: Hex,
      action: () => Promise<T>,
    ): Promise<T> {
      const lockKey = serviceRef.toLowerCase();
      let releaseGate!: () => void;
      const previous = settlementGates.get(lockKey) ?? Promise.resolve();
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      settlementGates.set(lockKey, gate);
      await previous;
      try {
        const client = await pool.connect();
        let locked = false;
        try {
          await client.query(
            "SELECT pg_advisory_lock(hashtextextended($1, 0))",
            [lockKey],
          );
          locked = true;
          return await action();
        } finally {
          try {
            if (locked) {
              await client.query(
                "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
                [lockKey],
              );
            }
          } finally {
            client.release();
          }
        }
      } finally {
        releaseGate();
        if (settlementGates.get(lockKey) === gate) {
          settlementGates.delete(lockKey);
        }
      }
    },

    /**
     * Atomic transition pending/expired → paid after an on-chain settlement.
     * A challenge can cross its TTL while the transaction is pending, so the
     * expiry sweep must not prevent persistence after funds have moved.
     * The contract enforces single-use of serviceRef, so at most one
     * on-chain submission can succeed; this UPDATE records the winner
     * without racing a concurrent verify request. Returns true if this
     * call performed the transition.
     *
     * Pass `buyerAgentId` from the on-chain `PaymentSettled` event when
     * the challenge was opened against an unregistered wallet
     * (`buyer_token_id = 0` placeholder) and the atomic register-and-settle
     * path minted a fresh agent. Without this backfill, the activity feed
     * and buyer-name resolver would stay stuck on `agent#0` for every
     * fresh-wallet purchase. For settle-only flows the placeholder already
     * holds the real agentId and the event's value equals it, so passing
     * it through is a no-op write.
     */
    async recordChallengePaid(
      serviceRef: Hex,
      paymentId: bigint,
      txHash: Hex,
      buyerAgentId?: bigint,
    ): Promise<boolean> {
      const setBuyer = buyerAgentId !== undefined;
      const res = await pool.query(
        `UPDATE payment_challenges
            SET status = 'paid',
                payment_id = $1,
                transaction_hash = $2,
                verified_at = now()${
                  setBuyer ? ",\n                buyer_token_id = $4" : ""
                }
          WHERE service_ref = $3
            AND (
              status IN ('pending', 'expired')
              OR (
                status = 'paid'
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
            SET status = 'expired'
          WHERE status = 'pending'
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
            WHERE status = 'expired'
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

    /**
     * Persist the EAS attestation UID for a successful buyer confirmation.
     * Match by paymentId (unique across the table). No-op when the
     * challenge row hasn't been written yet — the confirm path doesn't
     * have a hard dependency on a local row existing, since EAS is the
     * canonical store and we treat our DB as a deep-link convenience.
     *
     * Revisions overwrite: the resolver allows refUID-linked confirmation
     * revisions and rebalances counters, so we always want the latest UID
     * here so deep-links reflect the current state.
     */
    async recordConfirmation(
      paymentId: bigint,
      attestationUid: Hex,
    ): Promise<void> {
      await pool.query(
        `UPDATE payment_challenges
            SET confirmation_attestation_uid = $1
          WHERE payment_id = $2`,
        [hexToBytea(attestationUid), paymentId.toString()],
      );
    },

    /**
     * Challenge row by paymentId (set once the challenge transitions to
     * 'paid'). The reputation mirror uses this for cheap off-chain
     * enrichment (service slug → canonical feedback tag2); null for
     * payments that didn't come through this gateway.
     */
    async getChallengeByPaymentId(
      paymentId: bigint,
    ): Promise<StoredChallenge | null> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges WHERE payment_id = $1`,
        [paymentId.toString()],
      );
      return res.rows[0] ? rowToChallenge(res.rows[0]) : null;
    },

    ...createReputationQueries(pool),
    ...createSkillQueries(pool),
    ...createBuyerIdentityQueries(pool),
    ...createAggregateQueries(pool),

    ...createChainEventQueries(pool),
  };
}

export type Queries = ReturnType<typeof createQueries>;
