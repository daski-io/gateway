-- Retention scan for drafts that expired without ever carrying a payment
-- authorization (the unauthenticated 402 path creates one row per distinct
-- request body). The recovery worker deletes them in bounded batches.
CREATE INDEX IF NOT EXISTS standard_orders_unpaid_draft_retention_idx
  ON standard_orders(updated_at)
  WHERE state = 'NOT_SETTLED' AND authorization_key IS NULL;
