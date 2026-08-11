ALTER TABLE bazaar_orders DROP CONSTRAINT bazaar_orders_state_check;
ALTER TABLE bazaar_orders ADD CONSTRAINT bazaar_orders_state_check CHECK (
  state IN (
    'attempt_opened', 'verify_rejected', 'verify_ambiguous', 'settle_started',
    'settle_rejected', 'settle_ambiguous', 'settle_confirmed',
    'evidence_rejected', 'settled', 'dispatch_started', 'dispatch_ambiguous',
    'dispatch_failed', 'dispatched', 'rejected_expired_no_transfer',
    'ambiguous_expired_no_transfer', 'invalid_evidence_expired_no_transfer',
    'unapproved_direct_inbound', 'settlement_refund_due'
  )
);

CREATE TABLE bazaar_settlement_observations (
  order_record_id BYTEA PRIMARY KEY REFERENCES bazaar_orders(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  origin_state TEXT NOT NULL CHECK (origin_state IN (
    'verify_rejected', 'verify_ambiguous', 'settle_rejected',
    'settle_ambiguous', 'evidence_rejected'
  )),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'observing', 'no_transfer', 'unapproved_transfer', 'refund_due'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128
  ),
  lease_expires_at TIMESTAMPTZ,
  observed_through NUMERIC(78, 0) CHECK (
    observed_through IS NULL OR observed_through >= 0
  ),
  evidence_hash BYTEA CHECK (
    evidence_hash IS NULL OR octet_length(evidence_hash) = 32
  ),
  observed_transaction BYTEA UNIQUE CHECK (
    observed_transaction IS NULL OR octet_length(observed_transaction) = 32
  ),
  observed_block_hash BYTEA CHECK (
    observed_block_hash IS NULL OR octet_length(observed_block_hash) = 32
  ),
  transaction_index BIGINT CHECK (
    transaction_index IS NULL OR transaction_index >= 0
  ),
  authorization_log_index BIGINT CHECK (
    authorization_log_index IS NULL OR authorization_log_index >= 0
  ),
  transfer_log_index BIGINT CHECK (
    transfer_log_index IS NULL OR transfer_log_index >= 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state = 'observing' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (state <> 'observing' AND lease_token IS NULL AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state IN ('pending', 'observing') AND observed_through IS NULL
      AND evidence_hash IS NULL AND observed_transaction IS NULL
      AND observed_block_hash IS NULL AND transaction_index IS NULL
      AND authorization_log_index IS NULL AND transfer_log_index IS NULL)
    OR (state = 'no_transfer' AND observed_through IS NOT NULL
      AND evidence_hash IS NOT NULL AND observed_transaction IS NULL
      AND observed_block_hash IS NULL AND transaction_index IS NULL
      AND authorization_log_index IS NULL AND transfer_log_index IS NULL)
    OR (state IN ('unapproved_transfer', 'refund_due')
      AND observed_through IS NOT NULL AND evidence_hash IS NOT NULL
      AND observed_transaction IS NOT NULL AND observed_block_hash IS NOT NULL
      AND transaction_index IS NOT NULL AND authorization_log_index IS NOT NULL
      AND transfer_log_index IS NOT NULL)
  )
);

CREATE INDEX bazaar_settlement_observations_due_idx
  ON bazaar_settlement_observations (state, next_attempt_at)
  WHERE state = 'pending';
