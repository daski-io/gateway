-- Three-layer identity model fix (2026-05). Pre-fix, the gateway used
-- the buyer-supplied A2A skillId directly as the on-chain identifier,
-- which forced one Service row per skill — wrong cardinality. Post-fix,
-- the gateway resolves a `serviceSlug` (product category, e.g.
-- "domain-registration") from the skill's daski metadata in the
-- provider's Agent Card; multiple skills can map to one slug. Both the
-- slug AND the original skillId are persisted on the challenge so:
--   1. We have an audit trail of which (skill → service) mapping was
--      used at challenge-issue time, useful when debugging
--      cardinality regressions.
--   2. Re-deriving serviceId off the stored row matches the on-chain
--      hash without consulting the (potentially mutated) Agent Card.
ALTER TABLE payment_challenges
  ADD COLUMN service_slug TEXT;

CREATE INDEX idx_challenges_service_slug
  ON payment_challenges(service_slug);
