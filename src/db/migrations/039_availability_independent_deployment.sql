-- Availability is mutable state, not deployment shape: every paid skill has
-- its splitter and preparation regardless of acceptingNewOrders, so a
-- provider pauses and resumes through card refresh without a new listing
-- version. Replace the composite listing checks that coupled deployment to
-- availability (column-level checks are single-column and untouched).
DO $$
DECLARE violated record;
BEGIN
  FOR violated IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'standard_service_listings'::regclass
       AND contype = 'c'
       AND array_length(conkey, 1) > 1
  LOOP
    EXECUTE format(
      'ALTER TABLE standard_service_listings DROP CONSTRAINT %I',
      violated.conname
    );
  END LOOP;
END $$;

ALTER TABLE standard_service_listings
  ADD CONSTRAINT standard_service_listings_deployment_shape CHECK (
    (payment_required
      AND splitter_address IS NOT NULL AND preparation_json IS NOT NULL)
    OR
    (NOT payment_required
      AND splitter_address IS NULL AND preparation_json IS NULL
      AND NOT deployment_required)
  ),
  ADD CONSTRAINT standard_service_listings_deployment_flag CHECK (
    NOT deployment_required OR payment_required
  );
