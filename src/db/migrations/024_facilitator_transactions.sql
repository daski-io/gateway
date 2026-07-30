-- One durable nonce journal for every transaction signed by the facilitator.
-- Pre-production deployments must reconcile the operation-specific outboxes
-- before applying this forward-only migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM payment_challenges
     WHERE settlement_state IN ('settlement_prepared', 'settlement_broadcast')
  ) OR EXISTS (
    SELECT 1
      FROM reputation_mirrors
     WHERE prepared_tx IS NOT NULL
        OR status IN ('prepared', 'broadcast', 'processing')
  ) THEN
    RAISE EXCEPTION
      'reconcile facilitator transactions before migration 024';
  END IF;
END
$$;

CREATE TABLE facilitator_transactions (
  id UUID PRIMARY KEY,
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN (
      'settlement', 'buyer_confirmation', 'feedback_revoke', 'feedback_give'
    )),
  operation_key TEXT NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 256),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  intent_hash BYTEA NOT NULL CHECK (octet_length(intent_hash) = 32),
  status TEXT NOT NULL
    CHECK (status IN (
      'prepared', 'broadcast', 'succeeded', 'reverted', 'nonce_conflict'
    )),
  prepared_transaction BYTEA,
  transaction_hash BYTEA NOT NULL
    CHECK (octet_length(transaction_hash) = 32),
  transaction_nonce NUMERIC(78, 0) NOT NULL,
  operation_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  prepared_at TIMESTAMPTZ NOT NULL,
  broadcast_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  submission_attempts INTEGER NOT NULL DEFAULT 0 CHECK (submission_attempts >= 0),
  receipt_checks INTEGER NOT NULL DEFAULT 0 CHECK (receipt_checks >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) <= 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_kind, operation_key, attempt_number),
  CHECK (
    (
      status IN ('prepared', 'broadcast')
      AND prepared_transaction IS NOT NULL
      AND resolved_at IS NULL
    )
    OR (
      status IN ('succeeded', 'reverted', 'nonce_conflict')
      AND prepared_transaction IS NULL
      AND resolved_at IS NOT NULL
    )
  ),
  CHECK (
    (status = 'prepared' AND broadcast_at IS NULL)
    OR (status <> 'prepared' AND broadcast_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX facilitator_transactions_active_operation_idx
  ON facilitator_transactions (operation_kind, operation_key)
  WHERE status IN ('prepared', 'broadcast');

CREATE UNIQUE INDEX facilitator_transactions_single_prepared_idx
  ON facilitator_transactions ((true))
  WHERE status = 'prepared';

CREATE INDEX facilitator_transactions_due_prepared_idx
  ON facilitator_transactions (next_attempt_at, prepared_at)
  WHERE status = 'prepared';

CREATE INDEX facilitator_transactions_due_broadcast_idx
  ON facilitator_transactions (next_attempt_at, broadcast_at)
  WHERE status = 'broadcast';

CREATE INDEX facilitator_transactions_hash_idx
  ON facilitator_transactions (transaction_hash);

CREATE TABLE buyer_confirmation_submissions (
  id UUID PRIMARY KEY,
  payment_id NUMERIC(78, 0) NOT NULL,
  attester BYTEA NOT NULL CHECK (octet_length(attester) = 20),
  eas_attester_nonce NUMERIC(78, 0) NOT NULL,
  confirmation TEXT NOT NULL
    CHECK (confirmation IN ('Confirmed', 'NotConfirmed')),
  ref_uid BYTEA CHECK (ref_uid IS NULL OR octet_length(ref_uid) = 32),
  request_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(request_hash) = 32),
  facilitator_transaction_id UUID UNIQUE
    REFERENCES facilitator_transactions(id),
  attestation_uid BYTEA
    CHECK (attestation_uid IS NULL OR octet_length(attestation_uid) = 32),
  status TEXT NOT NULL
    CHECK (status IN (
      'prepared', 'broadcast', 'confirmed', 'reverted', 'nonce_conflict'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    status <> 'confirmed'
    OR (facilitator_transaction_id IS NOT NULL AND attestation_uid IS NOT NULL)
  )
);

CREATE UNIQUE INDEX buyer_confirmations_active_nonce_idx
  ON buyer_confirmation_submissions (attester, eas_attester_nonce)
  WHERE status IN ('prepared', 'broadcast');

CREATE UNIQUE INDEX buyer_confirmations_active_payment_idx
  ON buyer_confirmation_submissions (payment_id)
  WHERE status IN ('prepared', 'broadcast');

CREATE INDEX buyer_confirmations_payment_count_idx
  ON buyer_confirmation_submissions (payment_id, created_at);

CREATE TABLE confirmation_sponsorship_buckets (
  bucket_key TEXT NOT NULL,
  window_date DATE NOT NULL,
  sponsorship_count INTEGER NOT NULL CHECK (sponsorship_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_date)
);

ALTER TABLE payment_challenges
  ADD COLUMN settlement_facilitator_transaction_id UUID
    REFERENCES facilitator_transactions(id),
  ADD COLUMN provider_authority_wallet TEXT,
  ADD COLUMN provider_authority_agent_uri TEXT,
  ADD COLUMN provider_authority_block NUMERIC(78, 0);

ALTER TABLE reputation_mirrors
  DROP CONSTRAINT reputation_mirrors_prepared_transaction_check,
  DROP CONSTRAINT reputation_mirrors_broadcast_transaction_check,
  DROP CONSTRAINT reputation_mirrors_terminal_transaction_check,
  DROP CONSTRAINT reputation_mirrors_sent_hash_check,
  ADD COLUMN revoke_facilitator_transaction_id UUID
    REFERENCES facilitator_transactions(id),
  ADD COLUMN give_facilitator_transaction_id UUID
    REFERENCES facilitator_transactions(id);

DROP INDEX reputation_mirrors_facilitator_reservation_idx;
DROP INDEX reputation_mirrors_receipt_reconciliation_idx;
DROP INDEX reputation_mirrors_due_idx;

ALTER TABLE payment_challenges
  DROP CONSTRAINT payment_challenges_prepared_settlement_check,
  DROP CONSTRAINT payment_challenges_settlement_recovery_failure_check,
  DROP COLUMN prepared_transaction,
  DROP COLUMN prepared_transaction_nonce,
  DROP COLUMN prepared_at,
  DROP COLUMN settlement_recovery_failure_category,
  DROP COLUMN settlement_recovery_failure_detail,
  DROP COLUMN settlement_recovery_failure_at;

ALTER TABLE reputation_mirrors
  DROP COLUMN prepared_tx,
  DROP COLUMN tx_nonce,
  DROP COLUMN prepared_at,
  DROP COLUMN broadcast_at,
  DROP COLUMN receipt_checks;

CREATE INDEX payment_challenges_facilitator_transaction_idx
  ON payment_challenges (settlement_facilitator_transaction_id)
  WHERE settlement_facilitator_transaction_id IS NOT NULL;

CREATE INDEX reputation_mirrors_due_idx
  ON reputation_mirrors (next_attempt_at, updated_at)
  WHERE status IN ('queued', 'retry', 'processing');
