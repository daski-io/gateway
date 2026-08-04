-- Public task handles belong to the gateway. Provider task identifiers remain
-- internal routing data and can therefore change without changing the MCP
-- contract. This is a pre-production hard cut: no legacy provider IDs are
-- accepted after this migration.
DELETE FROM task_mappings;

DROP INDEX task_mappings_provider_task_idx;
ALTER TABLE task_mappings
  DROP CONSTRAINT task_mappings_task_id_length;

ALTER TABLE task_mappings
  RENAME COLUMN task_id TO provider_task_id;

ALTER TABLE task_mappings
  ADD COLUMN public_id_hash BYTEA NOT NULL,
  ADD COLUMN expires_at TIMESTAMPTZ NOT NULL;

ALTER TABLE task_mappings
  ADD CONSTRAINT task_mappings_public_id_hash_length
    CHECK (octet_length(public_id_hash) = 32),
  ADD CONSTRAINT task_mappings_provider_task_id_length
    CHECK (
      provider_task_id IS NULL OR
      length(provider_task_id) BETWEEN 1 AND 256
    ),
  ADD CONSTRAINT task_mappings_expiry_order
    CHECK (expires_at > created_at);

CREATE UNIQUE INDEX task_mappings_public_id_hash_idx
  ON task_mappings (public_id_hash);

CREATE INDEX task_mappings_provider_task_idx
  ON task_mappings (provider_a2a_url, provider_task_id)
  WHERE provider_task_id IS NOT NULL;

CREATE INDEX task_mappings_expires_at_idx
  ON task_mappings (expires_at);
