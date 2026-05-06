-- Buyer-identity cache. Populated whenever the gateway resolves a buyer's
-- display name (registration time, agentURI rotation). The on-chain
-- IdentityRegistry is the source of truth for `wallet_address ↔ agent_id`;
-- this table only exists so receipts and dashboards can render a stable
-- name without re-fetching the agentURI on every read. Names are NOT
-- enforced unique (Daski deliberately defers uniqueness to ENS — see the
-- buyer-naming spec) and the table is therefore append-update by
-- (agent_id) without any name-uniqueness constraint.

CREATE TABLE buyer_identities (
    agent_id        BIGINT PRIMARY KEY,
    wallet_address  TEXT NOT NULL,
    -- Display name resolved at registration time: for an `agentURI`-driven
    -- registration this is the JSON `name` field; for a `name`-driven one
    -- this is the sanitized name; for the zero-input default it is
    -- `buyer-<last6>` derived from the wallet.
    resolved_name   TEXT NOT NULL,
    -- Mirror of the on-chain agentURI we associated with `resolved_name`.
    -- Lets a future setAgentURI flow detect "the URI changed, refetch the
    -- name" without an extra on-chain read.
    agent_uri       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_buyer_identities_wallet
  ON buyer_identities(wallet_address);
