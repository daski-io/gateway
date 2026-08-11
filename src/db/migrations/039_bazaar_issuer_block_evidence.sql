ALTER TABLE bazaar_refund_obligations
  ADD COLUMN issuer_block_evidence_hash BYTEA CHECK (
    issuer_block_evidence_hash IS NULL OR (
      octet_length(issuer_block_evidence_hash) = 32 AND
      issuer_block_evidence_hash <> decode(repeat('00', 32), 'hex')
    )
  ),
  ADD COLUMN issuer_blocked_at TIMESTAMPTZ;

ALTER TABLE bazaar_refund_obligations DROP CONSTRAINT
  bazaar_refund_obligations_finalization_evidence_check;

ALTER TABLE bazaar_refund_obligations ADD CONSTRAINT
  bazaar_refund_obligations_progress_evidence_check CHECK (
    (state = 'due' AND broadcast_at IS NULL
      AND finalization_evidence_hash IS NULL
      AND finalization_block_hash IS NULL
      AND finalization_transfer_log_index IS NULL AND finalized_at IS NULL
      AND issuer_block_evidence_hash IS NULL AND issuer_blocked_at IS NULL)
    OR (state = 'blocked_issuer' AND broadcast_at IS NULL
      AND finalization_evidence_hash IS NULL
      AND finalization_block_hash IS NULL
      AND finalization_transfer_log_index IS NULL AND finalized_at IS NULL
      AND issuer_block_evidence_hash IS NOT NULL AND issuer_blocked_at IS NOT NULL)
    OR (state = 'broadcast' AND broadcast_at IS NOT NULL
      AND finalization_evidence_hash IS NULL
      AND finalization_block_hash IS NULL
      AND finalization_transfer_log_index IS NULL AND finalized_at IS NULL
      AND issuer_block_evidence_hash IS NULL AND issuer_blocked_at IS NULL)
    OR (state = 'finalized' AND broadcast_at IS NOT NULL
      AND finalization_evidence_hash IS NOT NULL
      AND finalization_block_hash IS NOT NULL
      AND finalization_transfer_log_index IS NOT NULL
      AND finalized_at IS NOT NULL
      AND issuer_block_evidence_hash IS NULL AND issuer_blocked_at IS NULL)
  );
