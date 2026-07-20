-- Make the payment lifecycle explicit instead of inferring it from status
-- plus the two transaction-hash columns.

ALTER TABLE payment_challenges
  DROP CONSTRAINT payment_challenges_status_check;
ALTER TABLE payment_challenges
  RENAME COLUMN status TO settlement_state;

UPDATE payment_challenges
   SET settlement_state = CASE
     WHEN settlement_state = 'paid' THEN 'paid'
     WHEN transaction_hash IS NOT NULL THEN 'attribution_broadcast'
     WHEN rail = 'external' AND external_settle_tx IS NOT NULL
       THEN 'external_settled'
     WHEN settlement_state = 'expired' THEN 'expired'
     ELSE 'pending'
   END;

ALTER TABLE payment_challenges
  ADD CONSTRAINT payment_challenges_settlement_state_check
  CHECK (
    settlement_state IN (
      'pending',
      'external_settled',
      'attribution_broadcast',
      'paid',
      'expired'
    )
  );

CREATE INDEX idx_challenges_unresolved_external
  ON payment_challenges(created_at)
  WHERE rail = 'external'
    AND settlement_state IN ('pending', 'external_settled', 'attribution_broadcast');
