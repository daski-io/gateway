-- A dispatched order's fulfillment duration never falls below its checkout
-- snapshot. A longer duration read from the listing that currently services
-- the order is recorded here, under the order's version and lease fence,
-- before its deadline relies on it, so a later shorter listing, paused sale,
-- missing listing or failed lookup cannot retract it. NULL records nothing
-- beyond the snapshot: every existing order, and every order the previous
-- runtime writes. Additive: the previous runtime reads orders with SELECT *
-- and ignores the column.
ALTER TABLE standard_orders ADD COLUMN effective_fulfillment_seconds BIGINT
  CHECK (effective_fulfillment_seconds IS NULL OR effective_fulfillment_seconds > 0);
