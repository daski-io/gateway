-- Complete the chain-derived uniqueness domain and retain durable security
-- incidents needed for standard-rail recovery and operator reconciliation.

CREATE UNIQUE INDEX standard_orders_settlement_tx_unique_idx
  ON standard_orders (lower(settlement_tx_hash))
  WHERE settlement_tx_hash IS NOT NULL;

CREATE UNIQUE INDEX standard_orders_provider_task_unique_idx
  ON standard_orders (provider_agent_id, provider_task_id)
  WHERE provider_task_id IS NOT NULL;

-- A release event covers an interval of orders, while each deposit and refund
-- transfer funds exactly one order under the admitted profile.
CREATE UNIQUE INDEX standard_chain_evidence_locator_unique_idx
  ON standard_chain_evidence (chain_id, lower(transaction_hash), log_index)
  WHERE evidence_kind IN ('deposit', 'refund');

CREATE UNIQUE INDEX standard_settlement_attempts_tx_unique_idx
  ON standard_settlement_attempts (lower(settlement_tx_hash))
  WHERE settlement_tx_hash IS NOT NULL;

CREATE TABLE standard_security_incidents (
  incident_id UUID PRIMARY KEY,
  incident_kind TEXT NOT NULL,
  order_id TEXT REFERENCES standard_orders(order_id),
  state TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (incident_kind, order_id)
);

CREATE INDEX standard_security_incidents_open_idx
  ON standard_security_incidents (detected_at)
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS _standard_cutover_approvals (
  environment TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  release_commit TEXT NOT NULL,
  manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
  archive_sha256 BYTEA NOT NULL CHECK (octet_length(archive_sha256) = 32),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, chain_id)
);
