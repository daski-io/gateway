-- Coordinate every durable pre-broadcast facilitator transaction and keep
-- reputation revisions from replacing signed transaction state.
ALTER TABLE reputation_mirrors
  ADD COLUMN prepared_at TIMESTAMPTZ,
  ADD COLUMN broadcast_at TIMESTAMPTZ,
  ADD COLUMN receipt_checks INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN pending_attestation_uid BYTEA,
  ADD COLUMN pending_confirmation TEXT,
  ADD COLUMN pending_ref_uid BYTEA;

UPDATE reputation_mirrors
   SET prepared_at = updated_at
 WHERE prepared_tx IS NOT NULL
   AND prepared_at IS NULL;

UPDATE reputation_mirrors
   SET broadcast_at = updated_at
 WHERE status = 'broadcast'
   AND prepared_tx IS NOT NULL
   AND broadcast_at IS NULL;

ALTER TABLE reputation_mirrors
  ADD CONSTRAINT reputation_mirrors_prepared_transaction_check
  CHECK (
    (
      prepared_tx IS NULL
      AND tx_nonce IS NULL
    )
    OR (
      prepared_tx IS NOT NULL
      AND tx_nonce IS NOT NULL
      AND tx_hash IS NOT NULL
      AND prepared_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT reputation_mirrors_broadcast_transaction_check
  CHECK (
    broadcast_at IS NULL
    OR (
      tx_hash IS NOT NULL
      AND prepared_at IS NOT NULL
      AND (
        (
          prepared_tx IS NOT NULL
          AND tx_nonce IS NOT NULL
        )
        OR (
          prepared_tx IS NULL
          AND tx_nonce IS NULL
          AND status IN ('sent', 'failed')
        )
      )
    )
  ),
  ADD CONSTRAINT reputation_mirrors_terminal_transaction_check
  CHECK (
    status NOT IN ('queued', 'sent', 'skipped')
    OR (prepared_tx IS NULL AND tx_nonce IS NULL)
  ),
  ADD CONSTRAINT reputation_mirrors_sent_hash_check
  CHECK (status <> 'sent' OR tx_hash IS NOT NULL),
  ADD CONSTRAINT reputation_mirrors_pending_revision_check
  CHECK (
    (
      pending_attestation_uid IS NULL
      AND pending_confirmation IS NULL
      AND pending_ref_uid IS NULL
    )
    OR (
      pending_attestation_uid IS NOT NULL
      AND pending_confirmation IN ('Confirmed', 'NotConfirmed')
    )
  );

CREATE INDEX reputation_mirrors_facilitator_reservation_idx
  ON reputation_mirrors (prepared_at, payment_id)
  WHERE prepared_tx IS NOT NULL
    AND tx_nonce IS NOT NULL
    AND tx_hash IS NOT NULL
    AND broadcast_at IS NULL;

CREATE INDEX reputation_mirrors_receipt_reconciliation_idx
  ON reputation_mirrors (next_attempt_at, updated_at)
  WHERE prepared_tx IS NOT NULL
    AND broadcast_at IS NOT NULL
    AND status IN ('broadcast', 'processing');
