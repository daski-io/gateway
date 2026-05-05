-- Postgres baseline for daski-gateway. The gateway only stores payment
-- challenges (the on-chain settlement is the source of truth for
-- everything else). This file replaces the legacy SQLite schema.

CREATE TABLE payment_challenges (
    -- 32-byte serviceRef from EIP-712 typed-data; primary key for the
    -- challenge issuance + settlement lifecycle. Stored as bytea so we
    -- don't have to lower-case strings on every lookup.
    service_ref         BYTEA PRIMARY KEY,
    provider_token_id   BIGINT NOT NULL,
    buyer_token_id      BIGINT NOT NULL,
    amount              BIGINT NOT NULL,
    skill_id            TEXT,
    provider_a2a_url    TEXT NOT NULL,
    -- Wallet address baked into the EIP-712 typed-data's `from` field at
    -- challenge issuance. /verify enforces auth.from === wallet_address
    -- so a third party can't settle their own signature against this
    -- challenge and leave it dangling.
    wallet_address      TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'expired')),
    payment_id          BIGINT,
    transaction_hash    TEXT,
    verified_at         TIMESTAMPTZ
);

CREATE INDEX idx_challenges_pending
  ON payment_challenges(status)
  WHERE status = 'pending';

-- Speeds up `expireStaleChallenges` UPDATE — without this, the WHERE
-- clause (status='pending' AND expires_at < now()) does a full scan of
-- pending rows. Becomes load-bearing once the table has any meaningful
-- backlog.
CREATE INDEX idx_challenges_pending_expires_at
  ON payment_challenges(expires_at)
  WHERE status = 'pending';

CREATE INDEX idx_challenges_txhash
  ON payment_challenges(transaction_hash)
  WHERE transaction_hash IS NOT NULL;

-- pgvector for `search_services` intent search. Embeddings are computed
-- by the discovery cache (Xenova all-MiniLM-L6-v2 → 384-dim float32).
-- Source text is stored so we can cheap-detect cache changes and avoid
-- recomputing embeddings on every refresh.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE skill_embeddings (
    provider_agent_id BIGINT NOT NULL,
    skill_id          TEXT NOT NULL,
    source_text       TEXT NOT NULL,
    embedding         VECTOR(384) NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_agent_id, skill_id)
);
