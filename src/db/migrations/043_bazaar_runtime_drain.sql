CREATE TABLE bazaar_runtime_transition_intents (
  source_epoch NUMERIC(78, 0) NOT NULL CHECK (source_epoch > 0),
  source_hash BYTEA NOT NULL CHECK (
    octet_length(source_hash) = 32 AND
    source_hash <> decode(repeat('00', 32), 'hex')
  ),
  target_epoch NUMERIC(78, 0) NOT NULL CHECK (target_epoch > source_epoch),
  target_hash BYTEA NOT NULL CHECK (
    octet_length(target_hash) = 32 AND
    target_hash <> decode(repeat('00', 32), 'hex')
  ),
  approval_digest BYTEA NOT NULL UNIQUE CHECK (
    octet_length(approval_digest) = 32 AND
    approval_digest <> decode(repeat('00', 32), 'hex')
  ),
  approval_signature BYTEA NOT NULL CHECK (
    octet_length(approval_signature) = 65
  ),
  approval_issued_at NUMERIC(78, 0) NOT NULL CHECK (approval_issued_at >= 0),
  approval_valid_before NUMERIC(78, 0) NOT NULL CHECK (
    approval_valid_before > approval_issued_at
  ),
  state TEXT NOT NULL CHECK (state IN ('draining', 'superseded', 'activated')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (source_epoch, target_epoch, target_hash),
  FOREIGN KEY (source_epoch, source_hash)
    REFERENCES bazaar_runtime_manifests (manifest_epoch, manifest_hash),
  CHECK (
    (state = 'draining' AND completed_at IS NULL) OR
    (state IN ('superseded', 'activated') AND completed_at IS NOT NULL AND
      completed_at >= requested_at)
  )
);

CREATE UNIQUE INDEX bazaar_runtime_transition_one_drain
  ON bazaar_runtime_transition_intents ((state))
  WHERE state = 'draining';
