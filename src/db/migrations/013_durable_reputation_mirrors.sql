-- Durable ERC-8004 mirror queue. The raw signed transaction is stored
-- before broadcast so worker recovery can rebroadcast the identical hash
-- instead of creating duplicate feedback after a process crash.
ALTER TABLE reputation_mirrors
  DROP CONSTRAINT reputation_mirrors_status_check;

ALTER TABLE reputation_mirrors
  ADD COLUMN confirmation TEXT
    CHECK (confirmation IN ('Confirmed', 'NotConfirmed')),
  ADD COLUMN ref_uid BYTEA,
  ADD COLUMN prepared_tx BYTEA,
  ADD COLUMN tx_nonce NUMERIC(78, 0),
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN last_error TEXT,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE reputation_mirrors
  ADD CONSTRAINT reputation_mirrors_status_check
  CHECK (
    status IN (
      'queued', 'processing', 'prepared', 'broadcast',
      'retry', 'sent', 'failed', 'skipped'
    )
  );

CREATE INDEX reputation_mirrors_due_idx
  ON reputation_mirrors (next_attempt_at, updated_at)
  WHERE status IN ('queued', 'prepared', 'broadcast', 'retry', 'processing');
