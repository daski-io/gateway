-- Expired challenges are retained briefly for diagnostics, then removed in
-- bounded batches by the gateway maintenance loop.

CREATE INDEX idx_challenges_expired_expires_at
  ON payment_challenges(expires_at)
  WHERE status = 'expired';
