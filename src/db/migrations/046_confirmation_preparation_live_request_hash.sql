-- A retired preparation (superseded by another label, or expired) keeps its
-- request hash, and an identical request prepared again within the same
-- second carries the same hash: the label was switched away and back before
-- the deadline advanced. Uniqueness of the request hash is required only
-- among live preparations; retired rows keep their operations and
-- sponsorships intact.
ALTER TABLE standard_confirmation_preparations
  DROP CONSTRAINT standard_confirmation_preparations_request_hash_key;
CREATE UNIQUE INDEX standard_confirmation_preparation_live_request_hash_idx
  ON standard_confirmation_preparations(request_hash) WHERE consumed_at IS NULL;
