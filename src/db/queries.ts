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
}

const ZERO_SERVICE_ID = ("0x" + "00".repeat(32)) as Hex;

function rowToChallenge(row: ChallengeRow): StoredChallenge {
  return {
    serviceRef: byteaToHex(row.service_ref),
    providerTokenId: BigInt(row.provider_token_id),
    buyerTokenId: BigInt(row.buyer_token_id),
    amount: BigInt(row.amount),
    skillId: row.skill_id ?? null,
    // Pre-refactor rows have NULL service_slug / service_version /
    // service_id (legacy before migrations 003 + 004). Surface a
    // sensible default for each so callers don't special-case the
    // absence — settlement on those was completed under the old
    // contract anyway.
    serviceSlug: row.service_slug ?? (row.skill_id ?? ""),
    serviceVersion: row.service_version ?? "1",
    serviceId: row.service_id ? byteaToHex(row.service_id) : ZERO_SERVICE_ID,
    providerA2AUrl: row.provider_a2a_url,
    walletAddress: (row.wallet_address as Hex) ?? ZERO_WALLET,
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
      serviceSlug: string;
      serviceVersion: string;
      serviceId: Hex;
      providerA2AUrl: string;
      walletAddress: Hex;
      expiresAt: Date;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO payment_challenges
           (service_ref, provider_token_id, buyer_token_id, amount, skill_id,
            service_slug, service_version, service_id,
            provider_a2a_url, wallet_address, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
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
     * Service-scoped sibling of listRecentPaidByProvider. Returns the last
     * `limit` paid challenges that hashed to this serviceId. Used by the
     * per-service fulfillment-time aggregate — that aggregate samples this
     * window rather than scanning all-time, so the RPC fan-out stays
     * bounded even on hot services.
     */
    async listRecentPaidByServiceId(
      serviceId: Hex,
      limit: number,
    ): Promise<StoredChallenge[]> {
      const res = await pool.query<ChallengeRow>(
        `SELECT * FROM payment_challenges
          WHERE status = 'paid' AND service_id = $1
          ORDER BY verified_at DESC
          LIMIT $2`,
        [hexToBytea(serviceId), limit],
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
     * Upserts a buyer-identity row. Called at registration time (and any
     * future setAgentURI rotation) with the resolved display name so
     * receipts and dashboards can render it without re-fetching the
     * agentURI. Uniqueness is enforced on `agent_id` only — Daski does
     * NOT enforce name uniqueness (see the buyer-naming spec).
     */
    async upsertBuyerIdentity(row: {
      agentId: bigint;
      walletAddress: Hex;
      resolvedName: string;
      agentURI: string;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO buyer_identities
           (agent_id, wallet_address, resolved_name, agent_uri)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_id) DO UPDATE SET
           wallet_address = EXCLUDED.wallet_address,
           resolved_name = EXCLUDED.resolved_name,
           agent_uri = EXCLUDED.agent_uri,
           updated_at = now()`,
        [
          row.agentId.toString(),
          row.walletAddress.toLowerCase(),
          row.resolvedName,
          row.agentURI,
        ],
      );
    },

    async getBuyerIdentity(agentId: bigint): Promise<{
      agentId: bigint;
      walletAddress: Hex;
      resolvedName: string;
      agentURI: string;
    } | null> {
      const res = await pool.query<{
        agent_id: string;
        wallet_address: string;
        resolved_name: string;
        agent_uri: string;
      }>(
        `SELECT agent_id, wallet_address, resolved_name, agent_uri
           FROM buyer_identities
          WHERE agent_id = $1`,
        [agentId.toString()],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        agentId: BigInt(row.agent_id),
        walletAddress: row.wallet_address as Hex,
        resolvedName: row.resolved_name,
        agentURI: row.agent_uri,
      };
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

    /**
     * Per-provider spend aggregate — total atomic USDC that has flowed
     * through this gateway destined for `providerAgentId`'s services.
     * Counts and dollar sum, same shape as `getPaidAggregate`. The
     * on-chain ReputationStorage tracks outcome counts but not amounts,
     * so the gateway DB is the only source of truth for "money in".
     */
    async getProviderSpend(
      providerAgentId: bigint,
    ): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount), 0)::bigint AS total_atomic
           FROM payment_challenges
          WHERE status = 'paid' AND provider_token_id = $1`,
        [providerAgentId.toString()],
      );
      const row = res.rows[0];
      return {
        count: Number(row.count),
        totalAtomic: BigInt(row.total_atomic),
      };
    },

    /**
     * Per-service spend aggregate. Filters on the on-chain serviceId
     * (BYTEA, indexed by migration 003). Same shape as `getProviderSpend`.
     * A provider with multiple services will have its provider-level spend
     * be the sum of all their service-level spends — useful sanity check.
     */
    async getServiceSpend(
      serviceId: Hex,
    ): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount), 0)::bigint AS total_atomic
           FROM payment_challenges
          WHERE status = 'paid' AND service_id = $1`,
        [hexToBytea(serviceId)],
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
