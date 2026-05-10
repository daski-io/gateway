-- Service-identity refactor (2026-05). Each payment now binds to a row in
-- the on-chain ServiceRegistry, identified by a 32-byte serviceId derived
-- from (providerAgentId, skillId, version). The gateway persists serviceId
-- and serviceVersion alongside skillId so:
--   1. /verify can cross-check the on-chain PaymentSettled event's
--      serviceId field rather than trusting only the adapter call args.
--   2. We have an audit trail of which service version a challenge
--      targeted (the version is part of the serviceId hash, so storing
--      both lets us reconstruct the derivation later).
-- service_id is stored as bytea for the same reason service_ref is —
-- spares us lower-casing strings on every lookup.
ALTER TABLE payment_challenges
  ADD COLUMN service_id BYTEA,
  ADD COLUMN service_version TEXT;

-- Index for per-service queries (future: discovery ranking, per-service
-- payment counts, etc.). Not strictly required by the gateway today, but
-- cheap to add now and load-bearing once we surface the per-service
-- views.
CREATE INDEX idx_challenges_service_id
  ON payment_challenges(service_id);
