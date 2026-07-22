-- Make the native payment lifecycle explicit instead of inferring a
-- broadcast from status plus transaction_hash.

ALTER TABLE payment_challenges
  DROP CONSTRAINT payment_challenges_status_check;
ALTER TABLE payment_challenges
  RENAME COLUMN status TO settlement_state;

UPDATE payment_challenges
   SET settlement_state = CASE
     WHEN settlement_state = 'paid' THEN 'paid'
     WHEN transaction_hash IS NOT NULL THEN 'settlement_broadcast'
     WHEN settlement_state = 'expired' THEN 'expired'
     ELSE 'pending'
   END;

ALTER TABLE payment_challenges
  ADD CONSTRAINT payment_challenges_settlement_state_check
  CHECK (
    settlement_state IN (
      'pending',
      'settlement_broadcast',
      'paid',
      'expired'
    )
  );
