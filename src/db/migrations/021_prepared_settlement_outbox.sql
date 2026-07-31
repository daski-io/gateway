-- Persist signed settlement transactions before submission so a gateway
-- crash cannot leave an unknown facilitator nonce in flight.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM payment_challenges
     WHERE settlement_state = 'settlement_broadcast'
  ) THEN
    RAISE EXCEPTION
      'reconcile settlement_broadcast challenges before migration 021';
  END IF;
END
$$;

ALTER TABLE payment_challenges
  DROP CONSTRAINT payment_challenges_settlement_state_check,
  ADD COLUMN prepared_transaction BYTEA,
  ADD COLUMN prepared_transaction_nonce BIGINT,
  ADD COLUMN prepared_at TIMESTAMPTZ,
  ADD COLUMN settlement_recovery_failure_category TEXT
    CHECK (
      settlement_recovery_failure_category IS NULL
      OR settlement_recovery_failure_category =
        'prepared_transaction_nonce_conflict'
    ),
  ADD COLUMN settlement_recovery_failure_detail TEXT,
  ADD COLUMN settlement_recovery_failure_at TIMESTAMPTZ;

ALTER TABLE payment_challenges
  ADD CONSTRAINT payment_challenges_settlement_state_check
  CHECK (
    settlement_state IN (
      'pending',
      'settlement_prepared',
      'settlement_broadcast',
      'paid',
      'expired',
      'sanctions_rejected'
    )
  ),
  ADD CONSTRAINT payment_challenges_prepared_settlement_check
  CHECK (
    (
      settlement_state IN ('settlement_prepared', 'settlement_broadcast')
      AND transaction_hash IS NOT NULL
      AND prepared_transaction IS NOT NULL
      AND prepared_transaction_nonce IS NOT NULL
      AND prepared_at IS NOT NULL
    )
    OR (
      settlement_state NOT IN ('settlement_prepared', 'settlement_broadcast')
      AND prepared_transaction IS NULL
      AND prepared_transaction_nonce IS NULL
      AND prepared_at IS NULL
      AND (settlement_state <> 'paid' OR transaction_hash IS NOT NULL)
    )
  ),
  ADD CONSTRAINT payment_challenges_settlement_recovery_failure_check
  CHECK (
    (
      settlement_recovery_failure_category IS NULL
      AND settlement_recovery_failure_detail IS NULL
      AND settlement_recovery_failure_at IS NULL
    )
    OR (
      settlement_state IN ('settlement_prepared', 'settlement_broadcast')
      AND settlement_recovery_failure_category IS NOT NULL
      AND settlement_recovery_failure_detail IS NOT NULL
      AND settlement_recovery_failure_at IS NOT NULL
    )
  );

CREATE INDEX payment_challenges_prepared_settlement_idx
  ON payment_challenges (prepared_at)
  WHERE settlement_state IN ('settlement_prepared', 'settlement_broadcast');
