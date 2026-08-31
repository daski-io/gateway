ALTER TABLE standard_orders
  ADD COLUMN intent_id TEXT,
  ADD COLUMN capability_epoch BIGINT NOT NULL DEFAULT 0
    CHECK (capability_epoch >= 0);

UPDATE standard_orders
   SET intent_id='legacy_' || order_id
 WHERE intent_id IS NULL;

ALTER TABLE standard_orders
  ALTER COLUMN intent_id SET NOT NULL,
  ADD CONSTRAINT standard_orders_intent_id_format
    CHECK (intent_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  ADD CONSTRAINT standard_orders_intent_id_key UNIQUE (intent_id);

CREATE UNIQUE INDEX standard_orders_payer_intent_uidx
  ON standard_orders(lower(payer),intent_id)
  WHERE payer IS NOT NULL;
