-- recipe-bound-v1 is retired: fresh databases admit only the current binding
-- profiles, so the schema states the invariant the admission code enforces.
ALTER TABLE standard_orders
  DROP CONSTRAINT standard_orders_binding_profile_check;
ALTER TABLE standard_orders
  ADD CONSTRAINT standard_orders_binding_profile_check
    CHECK (binding_profile IN ('stock-fixed-v1', 'recipe-bound-v2'));
