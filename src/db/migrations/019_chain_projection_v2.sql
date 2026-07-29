-- Event-driven, deployment-bound chain projection.
-- Pre-production projection rows and cursors are intentionally discarded.

DROP INDEX IF EXISTS chain_events_pending_idx;

ALTER TABLE chain_events
  ADD COLUMN reputation_eligible BOOLEAN,
  DROP COLUMN last_refreshed_at;

TRUNCATE TABLE chain_events;

ALTER TABLE chain_indexer_state
  ALTER COLUMN last_indexed_block DROP NOT NULL,
  ALTER COLUMN last_indexed_block DROP DEFAULT,
  ALTER COLUMN last_indexed_at DROP NOT NULL,
  ALTER COLUMN last_indexed_at DROP DEFAULT,
  ADD COLUMN chain_id BIGINT,
  ADD COLUMN payment_router_address BYTEA,
  ADD COLUMN reputation_storage_address BYTEA,
  ADD COLUMN eas_address BYTEA,
  ADD COLUMN confirmation_schema_uid BYTEA,
  ADD COLUMN start_block BIGINT;

UPDATE chain_indexer_state
   SET last_indexed_block = NULL,
       last_indexed_at = NULL,
       chain_id = NULL,
       payment_router_address = NULL,
       reputation_storage_address = NULL,
       eas_address = NULL,
       confirmation_schema_uid = NULL,
       start_block = NULL
 WHERE id = 1;
