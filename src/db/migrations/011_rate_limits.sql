-- Shared rate-limit state keeps facilitator-funded endpoints protected when
-- more than one gateway replica is running.

CREATE TABLE rate_limit_buckets (
    bucket_key          TEXT PRIMARY KEY,
    window_started_at   TIMESTAMPTZ NOT NULL,
    request_count       INTEGER NOT NULL CHECK (request_count > 0)
);

CREATE INDEX idx_rate_limit_buckets_started_at
  ON rate_limit_buckets(window_started_at);
