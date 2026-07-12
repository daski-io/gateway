import type { Pool } from "./pool.js";
import type { Hex, StoredChallenge } from "../types.js";
import { vectorLiteral } from "../discovery/embeddings.js";

export interface SkillSearchHit {
  providerAgentId: bigint;
  /** The service (card) the skill belongs to; '' for legacy single-card
   *  providers without a declared slug. Skill ids are only unique within
   *  a service, so aggregation keys on (provider, serviceSlug). */
  serviceSlug: string;
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
  rail: "daski" | "external" | null;
  auth_nonce: string | null;
  external_settle_tx: string | null;
  quote_id: string | null;
  quote_signature: string | null;
  quote_expires_at: Date | null;
  quote_request_hash: Buffer | null;
}

// reputation_mirrors row as pg returns it (BIGINT → string, BYTEA →
// Buffer). See migration 009 for column semantics.
interface ReputationMirrorDbRow {
  payment_id: string;
  attestation_uid: Buffer;
  provider_agent_id: string | null;
  feedback_index: string | null;
  tx_hash: Buffer | null;
  status: "sent" | "failed";
  updated_at: Date;
}

/** Decoded reputation_mirrors row — the mirror module's working shape. */
export interface ReputationMirrorRow {
  paymentId: bigint;
  attestationUid: Hex;
  providerAgentId: bigint | null;
  feedbackIndex: bigint | null;
  txHash: Hex | null;
  status: "sent" | "failed";
  updatedAt: Date;
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
    // Rows that pre-date migration 008 have NULL rail — they were all
    // gateway-settled, so default 'daski'.
    rail: row.rail ?? "daski",
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
     * Atomic transition pending → paid only if the row is still pending,
     * except for an expired external-rail row whose facilitator settlement
     * was already persisted. Funds have moved in that case, so attribution
     * must remain recoverable even after the original challenge TTL.
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
              status = 'pending'
              OR (
                status = 'expired'
                AND rail = 'external'
                AND external_settle_tx IS NOT NULL
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

    // ── Canonical-feedback mirror bookkeeping ──────────────────────────
    //
    // One row per paymentId tracking what the gateway posted to the
    // canonical ERC-8004 ReputationRegistry (see migration 009). The
    // registry is the source of truth for the feedback itself; these rows
    // exist for idempotency (skip re-posting on confirmation retries) and
    // revisions (feedback_index is what revokeFeedback needs).

    async getReputationMirror(
      paymentId: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const res = await pool.query<ReputationMirrorDbRow>(
        `SELECT * FROM reputation_mirrors WHERE payment_id = $1`,
        [paymentId.toString()],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        paymentId: BigInt(row.payment_id),
        attestationUid: byteaToHex(row.attestation_uid),
        providerAgentId:
          row.provider_agent_id != null ? BigInt(row.provider_agent_id) : null,
        feedbackIndex:
          row.feedback_index != null ? BigInt(row.feedback_index) : null,
        txHash: row.tx_hash ? byteaToHex(row.tx_hash) : null,
        status: row.status,
        updatedAt: row.updated_at,
      };
    },

    async upsertReputationMirror(row: {
      paymentId: bigint;
      attestationUid: Hex;
      providerAgentId: bigint | null;
      feedbackIndex: bigint | null;
      txHash: Hex | null;
      status: "sent" | "failed";
    }): Promise<void> {
      await pool.query(
        `INSERT INTO reputation_mirrors
           (payment_id, attestation_uid, provider_agent_id, feedback_index,
            tx_hash, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (payment_id) DO UPDATE
            SET attestation_uid = EXCLUDED.attestation_uid,
                provider_agent_id = EXCLUDED.provider_agent_id,
                feedback_index = EXCLUDED.feedback_index,
                tx_hash = EXCLUDED.tx_hash,
                status = EXCLUDED.status,
                updated_at = now()`,
        [
          row.paymentId.toString(),
          hexToBytea(row.attestationUid),
          row.providerAgentId != null ? row.providerAgentId.toString() : null,
          row.feedbackIndex != null ? row.feedbackIndex.toString() : null,
          row.txHash ? hexToBytea(row.txHash) : null,
          row.status,
        ],
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
        service_slug: string;
        skill_id: string;
        distance: number;
      }>(
        `SELECT provider_agent_id,
                service_slug,
                skill_id,
                (embedding <=> $1::vector)::float8 AS distance
           FROM skill_embeddings
          ORDER BY embedding <=> $1::vector
          LIMIT $2`,
        [vectorLiteral(queryEmbedding), limit],
      );
      return res.rows.map((r) => ({
        providerAgentId: BigInt(r.provider_agent_id),
        serviceSlug: r.service_slug ?? "",
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
     * Aggregate over **all** settled payments — sourced from chain_events
     * so the count and volume include transactions that settled through
     * other gateways or direct-to-router, not just this gateway's
     * facilitated rows. Matches what /activity displays.
     *
     * `totalAtomic` is the sum of `amount_atomic` columns (USDC atomic
     * units, 6 decimals). Caller divides by 1e6 for human display.
     */
    async getPaidAggregate(): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount_atomic), 0)::numeric AS total_atomic
           FROM chain_events`,
      );
      const row = res.rows[0];
      return {
        count: Number(row.count),
        totalAtomic: BigInt(row.total_atomic),
      };
    },

    /**
     * Per-provider spend aggregate — total atomic USDC that has settled
     * against `providerAgentId`'s services, across all gateways. Sourced
     * from chain_events so direct-to-router and other-gateway settlements
     * are included. Same shape as `getPaidAggregate`.
     */
    async getProviderSpend(
      providerAgentId: bigint,
    ): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount_atomic), 0)::numeric AS total_atomic
           FROM chain_events
          WHERE provider_agent_id = $1`,
        [providerAgentId.toString()],
      );
      const row = res.rows[0];
      return {
        count: Number(row.count),
        totalAtomic: BigInt(row.total_atomic),
      };
    },

    /**
     * Per-service spend aggregate. Filters chain_events on the on-chain
     * serviceId — same scope as `getServiceStats` on the contract, so
     * counts align with what other on-chain consumers see.
     */
    async getServiceSpend(
      serviceId: Hex,
    ): Promise<{ count: number; totalAtomic: bigint }> {
      const res = await pool.query<{ count: string; total_atomic: string }>(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(amount_atomic), 0)::numeric AS total_atomic
           FROM chain_events
          WHERE service_id = $1`,
        [hexToBytea(serviceId)],
      );
      const row = res.rows[0];
      return {
        count: Number(row.count),
        totalAtomic: BigInt(row.total_atomic),
      };
    },

    /**
     * Single-pass aggregate over a buyer's chain-events history. Returns
     * everything `/public/v1/buyers/:agentId` needs that can be computed
     * cheaply in SQL: spend / refund totals, outcome counters, fulfillment
     * mean, distinct provider+skill counts, and the first/last
     * settlement timestamps. Skill-bucketing isn't done here — the
     * provider/service-side patterns sample recent rows and group in JS,
     * and the same shape works for buyers too if we ever want it; the
     * counts of unique providers / skills give callers the "breadth"
     * signal without a per-row join.
     *
     * One query, two index lookups (chain_events_buyer_agent_id_settled_at_idx
     * for the bulk aggregate, payment_challenges PK via the LEFT JOIN for
     * the skill_id distinct count). Unindexed sort-merge of payment_challenges
     * rows is bounded by the buyer's own transaction count.
     */
    async aggregateChainActivityByBuyer(buyerAgentId: bigint): Promise<{
      transactionCount: number;
      totalSpentAtomic: bigint;
      totalRefundedAtomic: bigint;
      refundCount: number;
      completedCount: number;
      failedCount: number;
      canceledCount: number;
      confirmedCount: number;
      notConfirmedCount: number;
      uniqueProviderCount: number;
      uniqueSkillCount: number;
      fulfillmentSumSeconds: number;
      fulfillmentSampleSize: number;
      firstSettledAt: Date | null;
      lastSettledAt: Date | null;
    }> {
      const res = await pool.query<{
        transaction_count: string;
        total_spent_atomic: string;
        total_refunded_atomic: string;
        refund_count: string;
        completed_count: string;
        failed_count: string;
        canceled_count: string;
        confirmed_count: string;
        not_confirmed_count: string;
        unique_provider_count: string;
        unique_skill_count: string;
        fulfillment_sum_seconds: string;
        fulfillment_sample_size: string;
        first_settled_at: Date | null;
        last_settled_at: Date | null;
      }>(
        `SELECT COUNT(*)::bigint                                      AS transaction_count,
                COALESCE(SUM(ce.amount_atomic), 0)::numeric           AS total_spent_atomic,
                COALESCE(SUM(ce.refunded_atomic), 0)::numeric         AS total_refunded_atomic,
                COUNT(*) FILTER (WHERE ce.refunded_atomic > 0)::bigint AS refund_count,
                COUNT(*) FILTER (WHERE ce.outcome = 0)::bigint        AS completed_count,
                COUNT(*) FILTER (WHERE ce.outcome = 1)::bigint        AS failed_count,
                COUNT(*) FILTER (WHERE ce.outcome = 2)::bigint        AS canceled_count,
                COUNT(*) FILTER (WHERE ce.confirmation = 1)::bigint   AS confirmed_count,
                COUNT(*) FILTER (WHERE ce.confirmation = 2)::bigint   AS not_confirmed_count,
                COUNT(DISTINCT ce.provider_agent_id)::bigint          AS unique_provider_count,
                COUNT(DISTINCT pc.skill_id)::bigint                   AS unique_skill_count,
                COALESCE(SUM(ce.fulfillment_seconds), 0)::bigint      AS fulfillment_sum_seconds,
                COUNT(ce.fulfillment_seconds)::bigint                 AS fulfillment_sample_size,
                MIN(ce.settled_at)                                    AS first_settled_at,
                MAX(ce.settled_at)                                    AS last_settled_at
           FROM chain_events ce
           LEFT JOIN payment_challenges pc
                  ON pc.payment_id = ce.payment_id
                 AND pc.status = 'paid'
          WHERE ce.buyer_agent_id = $1`,
        [buyerAgentId.toString()],
      );
      const row = res.rows[0];
      return {
        transactionCount: Number(row.transaction_count),
        totalSpentAtomic: BigInt(row.total_spent_atomic),
        totalRefundedAtomic: BigInt(row.total_refunded_atomic),
        refundCount: Number(row.refund_count),
        completedCount: Number(row.completed_count),
        failedCount: Number(row.failed_count),
        canceledCount: Number(row.canceled_count),
        confirmedCount: Number(row.confirmed_count),
        notConfirmedCount: Number(row.not_confirmed_count),
        uniqueProviderCount: Number(row.unique_provider_count),
        uniqueSkillCount: Number(row.unique_skill_count),
        fulfillmentSumSeconds: Number(row.fulfillment_sum_seconds),
        fulfillmentSampleSize: Number(row.fulfillment_sample_size),
        firstSettledAt: row.first_settled_at,
        lastSettledAt: row.last_settled_at,
      };
    },

    /**
     * Buyer leaderboard for `/public/v1/buyers`. Ranks by lifetime USDC
     * spend descending; ties broken by transaction count (more = higher),
     * then by agentId for stability. LEFT JOIN onto buyer_identities so
     * the leaderboard can render a name without N round-trips — buyers
     * who registered outside this gateway return null and the public
     * route falls back to the wallet-derived default.
     */
    async listBuyersByVolume(limit: number): Promise<Array<{
      agentId: bigint;
      transactionCount: number;
      totalSpentAtomic: bigint;
      lastSettledAt: Date;
      resolvedName: string | null;
    }>> {
      const res = await pool.query<{
        agent_id: string;
        transaction_count: string;
        total_spent_atomic: string;
        last_settled_at: Date;
        resolved_name: string | null;
      }>(
        `SELECT ce.buyer_agent_id                            AS agent_id,
                COUNT(*)::bigint                             AS transaction_count,
                COALESCE(SUM(ce.amount_atomic), 0)::numeric  AS total_spent_atomic,
                MAX(ce.settled_at)                           AS last_settled_at,
                bi.resolved_name                             AS resolved_name
           FROM chain_events ce
           LEFT JOIN buyer_identities bi
                  ON bi.agent_id = ce.buyer_agent_id
          GROUP BY ce.buyer_agent_id, bi.resolved_name
          ORDER BY total_spent_atomic DESC,
                   transaction_count DESC,
                   ce.buyer_agent_id ASC
          LIMIT $1`,
        [limit],
      );
      return res.rows.map((r) => ({
        agentId: BigInt(r.agent_id),
        transactionCount: Number(r.transaction_count),
        totalSpentAtomic: BigInt(r.total_spent_atomic),
        lastSettledAt: r.last_settled_at,
        resolvedName: r.resolved_name,
      }));
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

    async listRecentChainActivityByBuyer(
      buyerAgentId: bigint,
      limit: number,
    ): Promise<ChainActivityRow[]> {
      const res = await pool.query<ChainActivityRowDb>(
        `${CHAIN_ACTIVITY_SELECT}
          WHERE ce.buyer_agent_id = $1
         ORDER BY ce.settled_at DESC
         LIMIT $2`,
        [buyerAgentId.toString(), limit],
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
