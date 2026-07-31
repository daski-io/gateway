-- Bound externally supplied task identifiers and reclaim abandoned dispatches.
DELETE FROM task_mappings
 WHERE length(context_id) NOT BETWEEN 1 AND 256
    OR (message_id IS NOT NULL AND length(message_id) NOT BETWEEN 1 AND 256)
    OR (task_id IS NOT NULL AND length(task_id) NOT BETWEEN 1 AND 256);

ALTER TABLE task_mappings
  ADD CONSTRAINT task_mappings_context_id_length
    CHECK (length(context_id) BETWEEN 1 AND 256),
  ADD CONSTRAINT task_mappings_message_id_length
    CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 256),
  ADD CONSTRAINT task_mappings_task_id_length
    CHECK (task_id IS NULL OR length(task_id) BETWEEN 1 AND 256);

CREATE INDEX task_mappings_pending_created_at_idx
  ON task_mappings (created_at)
  WHERE task_id IS NULL;

-- Settlement sponsorship is counted when a facilitator transaction is
-- durably prepared. The surrounding transaction rolls the bucket back when
-- reservation fails, so concurrent replicas cannot exceed either ceiling.
CREATE TABLE settlement_sponsorship_buckets (
  bucket_key TEXT NOT NULL,
  window_date DATE NOT NULL,
  sponsorship_count INTEGER NOT NULL CHECK (sponsorship_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_date)
);
