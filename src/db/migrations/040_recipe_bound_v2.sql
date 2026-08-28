-- Catalog-driven checkout binds orders with the recipe-bound-v2 profile:
-- the listing_manifest_hash slot carries the runtime listing commitment hash
-- and the provider_offer_hash slot the provider registration intent hash.
ALTER TABLE standard_orders
  DROP CONSTRAINT standard_orders_binding_profile_check;
ALTER TABLE standard_orders
  ADD CONSTRAINT standard_orders_binding_profile_check
    CHECK (binding_profile IN ('stock-fixed-v1', 'recipe-bound-v1', 'recipe-bound-v2'));
