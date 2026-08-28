-- The immutable runtime commitment identifies one admitted listing version.
-- Computed and stored at activation; bound into every V2 order nonce. The
-- canonical payload is stored beside its hash so any party can re-derive and
-- verify it without a second lookup.
ALTER TABLE standard_service_listings
  ADD COLUMN runtime_commitment_hash BYTEA CHECK (
    runtime_commitment_hash IS NULL OR octet_length(runtime_commitment_hash) = 32
  ),
  ADD COLUMN runtime_commitment_json JSONB;
