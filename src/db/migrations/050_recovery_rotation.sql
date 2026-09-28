-- Recovery visits recoverable orders least recently checked first. Ordering by
-- updated_at alone revisited the same oldest orders every batch, because a
-- poll that changes nothing leaves updated_at alone: fifty long fulfillment
-- waits could keep newer paid orders from ever being reconciled. Prior
-- runtimes ignore the column.
ALTER TABLE standard_orders ADD COLUMN recovery_checked_at TIMESTAMPTZ;
