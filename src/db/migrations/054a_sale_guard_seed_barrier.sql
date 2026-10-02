-- Install before immutable migration 055. CREATE TRIGGER takes the orders
-- table lock before backfill, so an incumbent insert either commits before
-- this snapshot or runs the trigger after commit. This also repairs missing
-- rows on databases that already applied the original 055.
CREATE FUNCTION standard_seed_order_sale_guard_install() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO standard_release_serialization_guards(guard_key)
  VALUES('release-sale:'||encode(NEW.listing_manifest_hash,'hex'))
  ON CONFLICT(guard_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_order_seed_sale_guard_install
  BEFORE INSERT ON standard_orders
  FOR EACH ROW EXECUTE FUNCTION standard_seed_order_sale_guard_install();

INSERT INTO standard_release_serialization_guards(guard_key)
SELECT DISTINCT 'release-sale:'||encode(listing_manifest_hash,'hex')
FROM standard_orders ON CONFLICT(guard_key) DO NOTHING;
