-- Ordinary purchases must not write the shared sale revision sentinel:
-- a concurrent unrelated settlement otherwise invalidates legacy SERIALIZABLE
-- claims. Seed before admission, then lock/read. Only release controls update
-- the row, so an old snapshot still fails when a stop actually raced it.
INSERT INTO standard_release_serialization_guards(guard_key)
SELECT DISTINCT 'release-sale:'||encode(listing_manifest_hash,'hex')
FROM standard_orders ON CONFLICT(guard_key) DO NOTHING;

CREATE FUNCTION standard_seed_order_sale_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO standard_release_serialization_guards(guard_key)
  VALUES('release-sale:'||encode(NEW.listing_manifest_hash,'hex'))
  ON CONFLICT(guard_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_order_seed_sale_guard
  BEFORE INSERT ON standard_orders
  FOR EACH ROW EXECUTE FUNCTION standard_seed_order_sale_guard();

CREATE OR REPLACE FUNCTION standard_assert_sale_open(provider_id TEXT, listing_hash BYTEA) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('release-sale:'||encode(listing_hash,'hex'),0));
  PERFORM 1 FROM standard_release_serialization_guards
    WHERE guard_key='release-sale:'||encode(listing_hash,'hex') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SALE_GUARD_MISSING'; END IF;
  IF EXISTS(SELECT 1 FROM standard_sale_controls
    WHERE provider_agent_id=provider_id AND listing_manifest_hash=listing_hash AND NOT accepting_new_orders) THEN
    RAISE EXCEPTION 'SALE_SUSPENDED';
  END IF;
END $$;
