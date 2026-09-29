-- Additive review protocol v2. Old workers select kind=confirmation and never
-- decode these preparations. A coordinated worker cutover precedes v2 writes.
ALTER TABLE standard_reputation_operations DROP CONSTRAINT standard_reputation_operations_kind_check;
ALTER TABLE standard_reputation_operations ADD CONSTRAINT standard_reputation_operations_kind_check
  CHECK (kind IN ('register','confirmation','confirmation-v2'));
ALTER TABLE standard_reputation_operations DROP CONSTRAINT standard_reputation_operations_state_check;
ALTER TABLE standard_reputation_operations ADD CONSTRAINT standard_reputation_operations_state_check
  CHECK (state IN ('pending','broadcast','final','operator_attention','aborted_unattested',
    'blocked_parent_aborted','confirmation_failed','authorization_live','superseded'));
ALTER TABLE standard_reputation_operations ADD COLUMN review_relay_until TIMESTAMPTZ;

CREATE TABLE standard_confirmation_preparations_v2
  (LIKE standard_confirmation_preparations INCLUDING ALL);
ALTER TABLE standard_confirmation_preparations_v2
  ADD FOREIGN KEY (order_id) REFERENCES standard_orders(order_id),
  ADD COLUMN profile_id TEXT NOT NULL CHECK (profile_id IN ('eas-native-1.0.1','eas-native-1.2.0')),
  ADD COLUMN signed_deadline BIGINT,
  ADD COLUMN profile_observation JSONB NOT NULL,
  ADD COLUMN supersedes_preparation_id UUID,
  ADD COLUMN authorization_group UUID NOT NULL,
  ADD COLUMN relay_candidate BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE standard_confirmation_preparations_v2 ADD CHECK
  ((profile_id='eas-native-1.0.1' AND signed_deadline IS NULL) OR
   (profile_id='eas-native-1.2.0' AND signed_deadline>0));
CREATE INDEX standard_confirmation_v2_group_idx ON standard_confirmation_preparations_v2(authorization_group);
CREATE TABLE standard_confirmation_sponsorships_v2
  (LIKE standard_confirmation_sponsorships INCLUDING ALL);
ALTER TABLE standard_confirmation_sponsorships_v2
  ADD FOREIGN KEY (preparation_id) REFERENCES standard_confirmation_preparations_v2(preparation_id),
  ADD FOREIGN KEY (operation_id) REFERENCES standard_reputation_operations(operation_id),
  ADD FOREIGN KEY (order_id) REFERENCES standard_orders(order_id);

CREATE TABLE standard_review_control (
  chain_id BIGINT PRIMARY KEY,
  paused BOOLEAN NOT NULL DEFAULT false,
  generation BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE standard_review_recovery (
  operation_id UUID PRIMARY KEY REFERENCES standard_reputation_operations(operation_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  release_id TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read-only unions let recovery find pre-v2 incidents without reinterpreting rows.
CREATE VIEW standard_review_preparations AS
SELECT p.*, 'eas-native-1.2.0'::text AS profile_id, p.deadline AS signed_deadline,
  NULL::jsonb AS profile_observation, NULL::uuid AS supersedes_preparation_id,
  p.preparation_id AS authorization_group, true AS relay_candidate, false AS protocol_v2
FROM standard_confirmation_preparations p
UNION ALL
SELECT p.*, true AS protocol_v2 FROM standard_confirmation_preparations_v2 p;
CREATE VIEW standard_review_sponsorships AS
SELECT s.*, false AS protocol_v2 FROM standard_confirmation_sponsorships s
UNION ALL
SELECT s.*, true AS protocol_v2 FROM standard_confirmation_sponsorships_v2 s;

CREATE TABLE standard_review_recovery_previews (
  proof_hash TEXT PRIMARY KEY, operation_id UUID NOT NULL REFERENCES standard_reputation_operations(operation_id),
  evidence JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
