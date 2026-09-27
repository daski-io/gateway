-- Additive recovery metadata; the existing dispatch wire and claim remain compatible.
CREATE TABLE standard_dispatch_recovery (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  claim_id UUID NOT NULL DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  retry_pending BOOLEAN NOT NULL DEFAULT false,
  refusals INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE standard_dispatch_refusals (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  claim_id UUID NOT NULL,
  dispatch_hash BYTEA NOT NULL,
  canonical_dispatch JSONB NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status BETWEEN 400 AND 599),
  reason JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE standard_operator_actions (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
