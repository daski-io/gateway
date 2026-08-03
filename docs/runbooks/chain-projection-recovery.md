# Chain projection recovery

Use this runbook when the chain-events indexer reports a descriptor mismatch
or projection-integrity failure, or when operators suspect a reorganization of
blocks already indexed. This includes a reorganization beyond the former
confirmation-depth boundary and any divergence at the current safe boundary.

The procedure deletes and rebuilds only the public chain projection. It must
not delete payment challenges, task mappings, facilitator transactions, or
other application data.

## Before recovery

1. Stop every gateway replica. Keep external traffic in maintenance until the
   recovery is complete.
2. Verify that no indexer holds the advisory lock. In one database session,
   run:

   ```sql
   SELECT pg_try_advisory_lock(
     hashtextextended('daski:chain-events-indexer:v2', 0)
   ) AS acquired;
   ```

   Continue only when `acquired` is `true`, then release the test lock in the
   same session:

   ```sql
   SELECT pg_advisory_unlock(
     hashtextextended('daski:chain-events-indexer:v2', 0)
   );
   ```

3. Record incident approval and take a restorable database backup. Verify the
   backup completed before continuing.
4. Confirm the canonical deployment values for `CHAIN_INDEXER_START_BLOCK`,
   `PAYMENT_ROUTER_ADDRESS`, `REPUTATION_STORAGE_ADDRESS`, `EAS_ADDRESS`, and
   `EAS_CONFIRMATION_SCHEMA_UID`. Correct the runtime configuration before
   resetting projection state.

## Reset and replay

Run the following as one explicit database transaction:

```sql
BEGIN;

TRUNCATE TABLE chain_events;

UPDATE chain_indexer_state
   SET last_indexed_block = NULL,
       last_indexed_at = NULL,
       chain_id = NULL,
       payment_router_address = NULL,
       reputation_storage_address = NULL,
       eas_address = NULL,
       confirmation_schema_uid = NULL,
       start_block = NULL,
       terminal_failure_category = NULL,
       terminal_failure_detail = NULL,
       terminal_failure_at = NULL
 WHERE id = 1;

COMMIT;
```

1. Start exactly one gateway replica. It will adopt the configured projection
   descriptor and replay events from `CHAIN_INDEXER_START_BLOCK` through the
   chain's `safe` head.
2. Monitor logs for another descriptor or projection-integrity failure. Leave
   traffic in maintenance if either recurs and verify the deployment values
   before attempting another reset.
3. Check `chain_indexer_state.last_indexed_block` until it matches the safe
   block returned by the configured indexer RPC endpoint.
4. Require `/health/ready` to return HTTP 200 before restoring traffic.
5. Start the remaining replicas and confirm `/health/ready` on each one.

There is no automatic cursor reset or production escape flag. Do not manually
advance or rewind `last_indexed_block`; an approved truncate-and-replay is the
recovery path for suspected projection divergence.
