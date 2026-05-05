import type { Pool } from "./pool.js";
import type { Hex, StoredChallenge } from "../types.js";
import { vectorLiteral } from "../discovery/embeddings.js";

export interface SkillSearchHit {
  providerAgentId: bigint;
  skillId: string;
  /** Cosine distance in [0, 2]; lower is more similar. */
  distance: number;
}

const ZERO_WALLET = "0x0000000000000000000000000000000000000000" as Hex;

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
  provider_a2a_url: string;
  wallet_address: string;
  created_at: Date;
  expires_at: Date;
  status: "pending" | "paid" | "expired";
  payment_id: string | null;
  transaction_hash: string | null;
  verified_at: Date | null;
}

function rowToChallenge(row: ChallengeRow): StoredChallenge {
  return {
    serviceRef: byteaToHex(row.service_ref),
    providerTokenId: BigInt(row.provider_token_id),
    buyerTokenId: BigInt(row.buyer_token_id),
    amount: BigInt(row.amount),
    skillId: row.skill_id ?? null,
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: (row.wallet_address as Hex) ?? ZERO_WALLET,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    paymentId: row.payment_id != null ? BigInt(row.payment_id) : null,
    transactionHash:
      row.transaction_hash != null ? (row.transaction_hash as Hex) : null,
    verifiedAt: row.verified_at,
  };
}

export function createQueries(pool: Pool) {
  return {
    async insertChallenge(challenge: {
      serviceRef: Hex;
      providerTokenId: bigint;
      buyerTokenId: bigint;
      amount: bigint;
      skillId: string | null;
      providerA2AUrl: string;
      walletAddress: Hex;
      expiresAt: Date;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO payment_challenges
           (service_ref, provider_token_id, buyer_token_id, amount, skill_id,
            provider_a2a_url, wallet_address, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          hexToBytea(challenge.serviceRef),
          challenge.providerTokenId.toString(),
          challenge.buyerTokenId.toString(),
          challenge.amount.toString(),
          challenge.skillId,
          challenge.providerA2AUrl,
          challenge.walletAddress.toLowerCase(),
          challenge.expiresAt,
        ],
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

    /**
     * Atomic transition pending → paid only if the row is still pending.
     * The contract enforces single-use of serviceRef, so at most one
     * on-chain submission can succeed; this UPDATE records the winner
     * without racing a concurrent verify request. Returns true if this
     * call performed the transition.
     */
    async recordChallengePaid(
      serviceRef: Hex,
      paymentId: bigint,
      txHash: Hex,
    ): Promise<boolean> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET status = 'paid',
                payment_id = $1,
                transaction_hash = $2,
                verified_at = now()
          WHERE service_ref = $3
            AND status = 'pending'`,
        [paymentId.toString(), normalizeHex(txHash), hexToBytea(serviceRef)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async expireStaleChallenges(): Promise<number> {
      const res = await pool.query(
        `UPDATE payment_challenges
            SET status = 'expired'
          WHERE status = 'pending' AND expires_at < now()`,
      );
      return res.rowCount ?? 0;
    },

    async listRecentPaid(limit: number): Promise<StoredChallenge[]> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges
          WHERE status = 'paid'
          ORDER BY verified_at DESC
          LIMIT $1`,
        [limit],
      );
      return res.rows.map(rowToChallenge);
    },

    async listRecentPaidByProvider(
      providerAgentId: bigint,
      limit: number,
    ): Promise<StoredChallenge[]> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges
          WHERE status = 'paid' AND provider_token_id = $1
          ORDER BY verified_at DESC
          LIMIT $2`,
        [providerAgentId.toString(), limit],
      );
      return res.rows.map(rowToChallenge);
    },

    /**
     * Top-N skill matches for an embedded intent vector, ordered by
     * cosine distance ascending. Used by `search_services`. Caller is
     * expected to dedupe/aggregate by provider.
     */
    async searchSkillsByEmbedding(
      queryEmbedding: Float32Array | number[],
      limit: number,
    ): Promise<SkillSearchHit[]> {
      const res = await pool.query<{
        provider_agent_id: string;
        skill_id: string;
        distance: number;
      }>(
        `SELECT provider_agent_id,
                skill_id,
                (embedding <=> $1::vector)::float8 AS distance
           FROM skill_embeddings
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [vectorLiteral(queryEmbedding), limit],
      );
      return res.rows.map((r) => ({
        providerAgentId: BigInt(r.provider_agent_id),
        skillId: r.skill_id,
        distance: Number(r.distance),
      }));
    },

    /**
     * Aggregate over all paid settlements that flowed through this
     * gateway. `totalAtomic` is the sum of `amount` columns (USDC atomic
     * units, 6 decimals). Caller divides by 1e6 for human display.
     */
    async getPaidAggregate(): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount), 0)::bigint AS total_atomic
           FROM payment_challenges
          WHERE status = 'paid'`,
      );
      const row = res.rows[0];
      return {
        count: Number(row.count),
        totalAtomic: BigInt(row.total_atomic),
      };
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;
