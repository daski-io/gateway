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
            AND status = 'pending'`,
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

    // ── chain_events: mirror of on-chain PaymentSettled + reputation ──
    //
    // The indexer populates this table; the public routes consume it.
    // payment_challenges is now a JOIN target for off-chain enrichment
    // (skillId, original a2a URL, etc.) — present only for rows this
    // gateway issued. Chain-only rows surface with thinner metadata.

    async getLastIndexedBlock(): Promise<bigint> {
      const res = await pool.query<{ last_indexed_block: string }>(
        `SELECT last_indexed_block FROM chain_indexer_state WHERE id = 1`,
      );
      if (res.rows.length === 0) return 0n;
      return BigInt(res.rows[0].last_indexed_block);
    },

    async setLastIndexedBlock(blockNumber: bigint): Promise<void> {
      await pool.query(
        `INSERT INTO chain_indexer_state (id, last_indexed_block, last_indexed_at)
            VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE
            SET last_indexed_block = EXCLUDED.last_indexed_block,
                last_indexed_at = EXCLUDED.last_indexed_at`,
        [blockNumber.toString()],
      );
    },

    async upsertChainEvent(args: {
      paymentId: bigint;
      txHash: Hex;
      blockNumber: bigint;
      serviceId: Hex;
      buyerAgentId: bigint;
      providerAgentId: bigint;
      amountAtomic: bigint;
      settledAt: Date;
      outcomeCode: number | null;
      confirmationCode: number;
      fulfillmentSeconds: number | null;
      refundedAtomic: bigint;
    }): Promise<void> {
      await pool.query(
        `INSERT INTO chain_events
           (payment_id, tx_hash, block_number, service_id, buyer_agent_id,
            provider_agent_id, amount_atomic, settled_at, outcome,
            confirmation, fulfillment_seconds, refunded_atomic,
            last_refreshed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (payment_id) DO UPDATE
            SET tx_hash = EXCLUDED.tx_hash,
                block_number = EXCLUDED.block_number,
                service_id = EXCLUDED.service_id,
                buyer_agent_id = EXCLUDED.buyer_agent_id,
                provider_agent_id = EXCLUDED.provider_agent_id,
                amount_atomic = EXCLUDED.amount_atomic,
                settled_at = EXCLUDED.settled_at,
                outcome = EXCLUDED.outcome,
                confirmation = EXCLUDED.confirmation,
                fulfillment_seconds = EXCLUDED.fulfillment_seconds,
                refunded_atomic = EXCLUDED.refunded_atomic,
                last_refreshed_at = now()`,
        [
          args.paymentId.toString(),
          hexToBytea(args.txHash),
          args.blockNumber.toString(),
          hexToBytea(args.serviceId),
          args.buyerAgentId.toString(),
          args.providerAgentId.toString(),
          args.amountAtomic.toString(),
          args.settledAt,
          args.outcomeCode,
          args.confirmationCode,
          args.fulfillmentSeconds,
          args.refundedAtomic.toString(),
        ],
      );
    },

    /**
     * Lighter-weight update for the refresh sweep — only the columns the
     * indexer re-reads (outcome, confirmation, fulfillment, refund). The
     * settle-time fields (tx_hash, block_number, ...) are immutable so
     * we skip touching them.
     */
    async refreshChainEvent(args: {
      paymentId: bigint;
      outcomeCode: number | null;
      confirmationCode: number;
      fulfillmentSeconds: number | null;
      refundedAtomic: bigint;
    }): Promise<void> {
      await pool.query(
        `UPDATE chain_events
            SET outcome = $2,
                confirmation = $3,
                fulfillment_seconds = $4,
                refunded_atomic = $5,
                last_refreshed_at = now()
          WHERE payment_id = $1`,
        [
          args.paymentId.toString(),
          args.outcomeCode,
          args.confirmationCode,
          args.fulfillmentSeconds,
          args.refundedAtomic.toString(),
        ],
      );
    },

    /**
     * Rows whose state is still mutable (confirmation pending OR
     * refund still zero) and that haven't been refreshed within the
     * cutoff. Used by the indexer's refresh sweep.
     */
    async listStaleChainEvents(
      cutoff: Date,
      limit: number,
    ): Promise<Array<{ paymentId: bigint }>> {
      const res = await pool.query<{ payment_id: string }>(
        `SELECT payment_id FROM chain_events
          WHERE (confirmation = 0 OR refunded_atomic = 0)
            AND last_refreshed_at < $1
          ORDER BY last_refreshed_at ASC
          LIMIT $2`,
        [cutoff, limit],
      );
      return res.rows.map((r) => ({ paymentId: BigInt(r.payment_id) }));
    },

    // Activity feed: chain-events as source, payment_challenges as
    // optional enrichment. Returns rows in `settled_at DESC` order
    // capped at `limit`. Used by /public/v1/activity.
    async listRecentChainActivity(
      limit: number,
    ): Promise<ChainActivityRow[]> {
      const res = await pool.query<ChainActivityRowDb>(
        `${CHAIN_ACTIVITY_SELECT}
         ORDER BY ce.settled_at DESC
         LIMIT $1`,
        [limit],
      );
      return res.rows.map(rowToChainActivity);
    },

    async listRecentChainActivityByProvider(
      providerAgentId: bigint,
      limit: number,
    ): Promise<ChainActivityRow[]> {
      const res = await pool.query<ChainActivityRowDb>(
        `${CHAIN_ACTIVITY_SELECT}
          WHERE ce.provider_agent_id = $1
         ORDER BY ce.settled_at DESC
         LIMIT $2`,
        [providerAgentId.toString(), limit],
      );
      return res.rows.map(rowToChainActivity);
    },

    async listRecentChainActivityByServiceId(
      serviceId: Hex,
      limit: number,
    ): Promise<ChainActivityRow[]> {
      const res = await pool.query<ChainActivityRowDb>(
        `${CHAIN_ACTIVITY_SELECT}
          WHERE ce.service_id = $1
         ORDER BY ce.settled_at DESC
         LIMIT $2`,
        [hexToBytea(serviceId), limit],
      );
      return res.rows.map(rowToChainActivity);
    },
  };
}

/**
 * One row of the chain-events read view: everything chain_events
 * provides plus the optional payment_challenges enrichment (null
 * fields when the row settled outside this gateway).
 */
export interface ChainActivityRow {
  paymentId: bigint;
  txHash: Hex;
  blockNumber: bigint;
  serviceId: Hex;
  buyerAgentId: bigint;
  providerAgentId: bigint;
  amountAtomic: bigint;
  settledAt: Date;
  outcomeCode: number | null;
  confirmationCode: number;
  fulfillmentSeconds: number | null;
  refundedAtomic: bigint;
  // Off-chain enrichment from payment_challenges (null for chain-only rows)
  skillId: string | null;
  serviceSlug: string | null;
  serviceVersion: string | null;
  providerA2AUrl: string | null;
  walletAddress: Hex | null;
  confirmationAttestationUid: Hex | null;
}

interface ChainActivityRowDb {
  payment_id: string;
  tx_hash: Buffer;
  block_number: string;
  service_id: Buffer;
  buyer_agent_id: string;
  provider_agent_id: string;
  amount_atomic: string;
  settled_at: Date;
  outcome: number | null;
  confirmation: number;
  fulfillment_seconds: number | null;
  refunded_atomic: string;
  skill_id: string | null;
  service_slug: string | null;
  service_version: string | null;
  provider_a2a_url: string | null;
  wallet_address: string | null;
  confirmation_attestation_uid: Buffer | null;
}

const CHAIN_ACTIVITY_SELECT = `
  SELECT ce.payment_id, ce.tx_hash, ce.block_number, ce.service_id,
         ce.buyer_agent_id, ce.provider_agent_id, ce.amount_atomic,
         ce.settled_at, ce.outcome, ce.confirmation,
         ce.fulfillment_seconds, ce.refunded_atomic,
         pc.skill_id, pc.service_slug, pc.service_version,
         pc.provider_a2a_url, pc.wallet_address,
         pc.confirmation_attestation_uid
    FROM chain_events ce
    LEFT JOIN payment_challenges pc
           ON pc.payment_id = ce.payment_id
          AND pc.status = 'paid'
`;

function rowToChainActivity(r: ChainActivityRowDb): ChainActivityRow {
  return {
    paymentId: BigInt(r.payment_id),
    txHash: byteaToHex(r.tx_hash),
    blockNumber: BigInt(r.block_number),
    serviceId: byteaToHex(r.service_id),
    buyerAgentId: BigInt(r.buyer_agent_id),
    providerAgentId: BigInt(r.provider_agent_id),
    amountAtomic: BigInt(r.amount_atomic),
    settledAt: r.settled_at,
    outcomeCode: r.outcome,
    confirmationCode: r.confirmation,
    fulfillmentSeconds: r.fulfillment_seconds,
    refundedAtomic: BigInt(r.refunded_atomic),
    skillId: r.skill_id,
    serviceSlug: r.service_slug,
    serviceVersion: r.service_version,
    providerA2AUrl: r.provider_a2a_url,
    walletAddress: (r.wallet_address as Hex | null) ?? null,
    confirmationAttestationUid: r.confirmation_attestation_uid
      ? byteaToHex(r.confirmation_attestation_uid)
      : null,
  };
}

export type Queries = ReturnType<typeof createQueries>;
