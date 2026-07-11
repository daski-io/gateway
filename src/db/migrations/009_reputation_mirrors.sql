-- Canonical-feedback mirror bookkeeping (2026-07). After a buyer
-- confirmation lands on EAS, the gateway's facilitator wallet mirrors it
-- as public ERC-8004 feedback on the CANONICAL ReputationRegistry
-- (0x8004B... per chain) — that write is fire-and-forget relative to the
-- buyer's confirmation response, so this table is what makes it safe:
--
--   * Idempotency: one row per payment_id. A confirmation retry that
--     finds status='sent' skips the second giveFeedback instead of
--     double-posting.
--   * Revisions: confirmation revisions (EAS refUID chains) revoke the
--     prior canonical entry before posting a fresh one. revokeFeedback
--     needs the per-(agent, client) feedback index, so we persist the
--     index read back via getLastIndex after each successful post.
--   * Retry-ability: failures record status='failed'; the next
--     confirmation attempt for the payment re-runs the mirror.
--
-- The canonical registry is the source of truth for the feedback itself
-- (this table stores none of the value/tag payload) — these rows exist
-- only so the gateway knows what it already posted and how to revoke it.
CREATE TABLE reputation_mirrors (
  payment_id         BIGINT PRIMARY KEY,
  -- EAS confirmation attestation the feedback entry cites as evidence
  -- (feedbackHash + easscan feedbackURI both derive from it).
  attestation_uid    BYTEA NOT NULL,
  -- Provider the feedback was posted against. NULL only on early
  -- failures where the payment lookup itself failed.
  provider_agent_id  BIGINT,
  -- 1-based per-(agentId, clientAddress) index on the canonical registry,
  -- read via getLastIndex after a successful giveFeedback. NULL until the
  -- first successful post; required for future revokeFeedback calls.
  feedback_index     BIGINT,
  -- giveFeedback tx hash of the latest successful post.
  tx_hash            BYTEA,
  status             TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
