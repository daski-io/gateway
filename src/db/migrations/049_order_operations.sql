-- Additive: prior runtimes ignore payer-bound readiness and operational views.
ALTER TABLE standard_orders ADD COLUMN expected_payer TEXT;
ALTER TABLE standard_orders ADD CONSTRAINT standard_orders_expected_payer_shape
  CHECK (expected_payer IS NULL OR expected_payer ~ '^0x[0-9a-f]{40}$');
CREATE INDEX standard_orders_payer_drafts_idx ON standard_orders
  (provider_agent_id,outcome_id,canonical_request_hash,listing_manifest_hash,
   provider_offer_hash,rail_epoch,expected_payer,expires_at)
  WHERE state IN ('DRAFT','CHALLENGE_ISSUED');

-- Only safe progress metadata is retained: missing DNS records are stripped.
-- The full projection hash still detects same-revision equivocation.
CREATE TABLE standard_order_operations (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  revision BIGINT NOT NULL CHECK (revision >= 0),
  observed_at BIGINT NOT NULL CHECK (observed_at >= 0),
  projection_hash BYTEA NOT NULL,
  safe_projection JSONB NOT NULL,
  wait_seconds BIGINT NOT NULL DEFAULT 0 CHECK (wait_seconds >= 0),
  original_terminal JSONB,
  last_poll_at TIMESTAMPTZ,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
