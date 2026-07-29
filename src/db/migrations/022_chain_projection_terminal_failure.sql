-- Share terminal projection failures across gateway replicas so followers
-- cannot report healthy after the leader detects corrupted projection state.

ALTER TABLE chain_indexer_state
  ADD COLUMN terminal_failure_category TEXT
    CHECK (
      terminal_failure_category IN (
        'descriptor_mismatch',
        'projection_integrity'
      )
    ),
  ADD COLUMN terminal_failure_detail TEXT,
  ADD COLUMN terminal_failure_at TIMESTAMPTZ;

ALTER TABLE chain_indexer_state
  ADD CONSTRAINT chain_indexer_terminal_failure_check
  CHECK (
    (
      terminal_failure_category IS NULL
      AND terminal_failure_detail IS NULL
      AND terminal_failure_at IS NULL
    )
    OR (
      terminal_failure_category IS NOT NULL
      AND terminal_failure_detail IS NOT NULL
      AND terminal_failure_at IS NOT NULL
    )
  );
