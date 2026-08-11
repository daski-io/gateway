ALTER TABLE bazaar_orders DROP CONSTRAINT bazaar_orders_state_check;
ALTER TABLE bazaar_orders ADD CONSTRAINT bazaar_orders_state_check CHECK (
  state IN (
    'attempt_opened', 'verify_rejected', 'verify_ambiguous', 'settle_started',
    'settle_rejected', 'settle_ambiguous', 'settle_confirmed',
    'evidence_rejected', 'settled', 'dispatch_started', 'dispatch_ambiguous',
    'dispatch_failed', 'dispatched', 'rejected_expired_no_transfer',
    'ambiguous_expired_no_transfer', 'invalid_evidence_expired_no_transfer',
    'unapproved_direct_inbound', 'settlement_refund_due', 'refund_finalized',
    'refund_blocked_issuer'
  )
);

ALTER TABLE bazaar_refund_obligations ADD COLUMN evidence_hash BYTEA CHECK (
  evidence_hash IS NULL OR octet_length(evidence_hash) = 32
);
ALTER TABLE bazaar_refund_obligations ADD COLUMN broadcast_at TIMESTAMPTZ;
ALTER TABLE bazaar_refund_obligations ADD COLUMN
  finalization_evidence_hash BYTEA CHECK (
    finalization_evidence_hash IS NULL OR
    octet_length(finalization_evidence_hash) = 32
  );
ALTER TABLE bazaar_refund_obligations ADD COLUMN
  finalization_block_hash BYTEA CHECK (
    finalization_block_hash IS NULL OR octet_length(finalization_block_hash) = 32
  );
ALTER TABLE bazaar_refund_obligations ADD COLUMN
  finalization_transfer_log_index BIGINT CHECK (
    finalization_transfer_log_index IS NULL OR
    finalization_transfer_log_index >= 0
  );
ALTER TABLE bazaar_refund_obligations ADD COLUMN finalized_at TIMESTAMPTZ;
ALTER TABLE bazaar_refund_obligations ADD CONSTRAINT
  bazaar_refund_obligations_finalization_evidence_check CHECK (
    (state IN ('due', 'blocked_issuer') AND broadcast_at IS NULL
      AND finalization_evidence_hash IS NULL
      AND finalization_block_hash IS NULL
      AND finalization_transfer_log_index IS NULL AND finalized_at IS NULL)
    OR (state = 'broadcast' AND broadcast_at IS NOT NULL
      AND finalization_evidence_hash IS NULL
      AND finalization_block_hash IS NULL
      AND finalization_transfer_log_index IS NULL AND finalized_at IS NULL)
    OR (state = 'finalized' AND broadcast_at IS NOT NULL
      AND finalization_evidence_hash IS NOT NULL
      AND finalization_block_hash IS NOT NULL
      AND finalization_transfer_log_index IS NOT NULL
      AND finalized_at IS NOT NULL)
  );

CREATE TABLE bazaar_refund_jobs (
  order_record_id BYTEA PRIMARY KEY
    REFERENCES bazaar_refund_obligations(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'working', 'complete', 'blocked'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128
  ),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state = 'working' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (state <> 'working' AND lease_token IS NULL AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  )
);

CREATE INDEX bazaar_refund_jobs_due_idx
  ON bazaar_refund_jobs (state, next_attempt_at)
  WHERE state = 'pending';
