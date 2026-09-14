-- Delivery confirmations count submissions, not transitions: up to three
-- attestations per order, and the current one can always be revoked. The
-- stored per-order confirmation state is written only from finalized,
-- hash-pinned reads (spec B7).
ALTER TABLE standard_confirmation_preparations
  RENAME COLUMN transitions_used TO submissions_used;
ALTER TABLE standard_confirmation_preparations
  DROP CONSTRAINT standard_confirmation_preparations_transitions_used_check;
ALTER TABLE standard_confirmation_preparations
  ADD CONSTRAINT standard_confirmation_preparations_submissions_used_check
    CHECK (submissions_used BETWEEN 0 AND 3);

ALTER TABLE standard_reputation_confirmations
  RENAME COLUMN transitions_used TO submissions_used;
ALTER TABLE standard_reputation_confirmations
  RENAME CONSTRAINT standard_reputation_confirmations_transitions_used_check
    TO standard_reputation_confirmations_submissions_used_check;
