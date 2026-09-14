-- A sponsored confirmation operation is final once its receipt is at the
-- configured depth, but the order's stored confirmation state follows only
-- from a finalized read (spec B7). The finalized tag can still be behind the
-- receipt at that moment, and nothing else refreshes the stored state, so
-- the worker keeps reconciling the operation until the finalized anchor
-- covers the receipt's block and records when it did.
ALTER TABLE standard_reputation_operations
  ADD COLUMN confirmation_reconciled_at TIMESTAMPTZ;
CREATE INDEX standard_reputation_operations_reconcile_idx
  ON standard_reputation_operations(next_attempt_at)
  WHERE kind='confirmation' AND state='final' AND confirmation_reconciled_at IS NULL;
