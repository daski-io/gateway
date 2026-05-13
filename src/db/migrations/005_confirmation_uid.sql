-- EAS attestation UID persistence (2026-05). When a buyer confirms delivery
-- via /confirm/:paymentId, the EAS resolver records the attestation on-chain
-- and returns its 32-byte UID. Pre-refactor we returned the UID in the
-- response and dropped it on the floor; downstream consumers (the marketing
-- site's activity feed, future receipts page) couldn't deep-link to the
-- canonical attestation on an EAS explorer.
--
-- Stored on the existing payment_challenges row keyed by paymentId. NULL
-- means "no confirmation attested yet" or "confirmation came in before
-- this column existed". Revisions overwrite: the latest UID is the one
-- whose value the ReputationStorage counters reflect.
ALTER TABLE payment_challenges
  ADD COLUMN confirmation_attestation_uid BYTEA;
