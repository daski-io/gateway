ALTER TABLE bazaar_runtime_manifests
  ADD COLUMN approval_authority BYTEA CHECK (
    approval_authority IS NULL OR (
      octet_length(approval_authority) = 20 AND
      approval_authority <> decode(repeat('00', 20), 'hex')
    )
  ),
  ADD COLUMN deployment_id BYTEA CHECK (
    deployment_id IS NULL OR (
      octet_length(deployment_id) = 32 AND
      deployment_id <> decode(repeat('00', 32), 'hex')
    )
  ),
  ADD CONSTRAINT bazaar_runtime_manifest_provenance_check CHECK (
    (approval_authority IS NULL AND deployment_id IS NULL) OR
    (approval_authority IS NOT NULL AND deployment_id IS NOT NULL)
  ),
  ADD CONSTRAINT bazaar_runtime_manifest_provenance_key UNIQUE (
    manifest_epoch, approval_authority, deployment_id
  ),
  ADD CONSTRAINT bazaar_runtime_manifest_identity_key UNIQUE (
    manifest_epoch, manifest_hash
  );

ALTER TABLE bazaar_key_roles DROP CONSTRAINT bazaar_key_roles_key_role_check;
ALTER TABLE bazaar_key_roles ADD CONSTRAINT bazaar_key_roles_key_role_check
  CHECK (key_role IN (
    'provider', 'fulfillment', 'daski_lifecycle', 'daski_refund',
    'daski_manifest'
  ));

CREATE TABLE bazaar_runtime_manifest_approvals (
  manifest_epoch NUMERIC(78, 0) NOT NULL,
  approval_authority BYTEA NOT NULL CHECK (
    octet_length(approval_authority) = 20 AND
    approval_authority <> decode(repeat('00', 20), 'hex')
  ),
  deployment_id BYTEA NOT NULL CHECK (
    octet_length(deployment_id) = 32 AND
    deployment_id <> decode(repeat('00', 32), 'hex')
  ),
  approval_digest BYTEA NOT NULL UNIQUE CHECK (
    octet_length(approval_digest) = 32 AND
    approval_digest <> decode(repeat('00', 32), 'hex')
  ),
  approval_signature BYTEA NOT NULL CHECK (
    octet_length(approval_signature) = 65
  ),
  issued_at NUMERIC(78, 0) NOT NULL CHECK (issued_at >= 0),
  valid_before NUMERIC(78, 0) NOT NULL CHECK (valid_before > issued_at),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_epoch, approval_digest),
  FOREIGN KEY (manifest_epoch, approval_authority, deployment_id)
    REFERENCES bazaar_runtime_manifests (
      manifest_epoch, approval_authority, deployment_id
    )
);

CREATE TABLE bazaar_runtime_executions (
  execution_id BYTEA PRIMARY KEY CHECK (
    octet_length(execution_id) = 32 AND
    execution_id <> decode(repeat('00', 32), 'hex')
  ),
  manifest_epoch NUMERIC(78, 0) NOT NULL CHECK (manifest_epoch > 0),
  manifest_hash BYTEA NOT NULL CHECK (
    octet_length(manifest_hash) = 32 AND
    manifest_hash <> decode(repeat('00', 32), 'hex')
  ),
  lease_token UUID NOT NULL,
  lease_owner TEXT NOT NULL CHECK (length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (manifest_epoch, manifest_hash)
    REFERENCES bazaar_runtime_manifests (manifest_epoch, manifest_hash)
);

CREATE INDEX bazaar_runtime_executions_expiry_idx
  ON bazaar_runtime_executions (lease_expires_at);

CREATE TABLE bazaar_challenge_mac_epochs (
  key_epoch TEXT PRIMARY KEY CHECK (
    key_epoch ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
  ),
  secret_commitment BYTEA NOT NULL UNIQUE CHECK (
    octet_length(secret_commitment) = 32 AND
    secret_commitment <> decode(repeat('00', 32), 'hex')
  ),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  accept_until NUMERIC(78, 0),
  CHECK (
    (retired_at IS NULL AND accept_until IS NULL) OR
    (retired_at IS NOT NULL AND accept_until IS NOT NULL AND accept_until >= 0)
  )
);

CREATE UNIQUE INDEX bazaar_challenge_mac_epochs_one_active
  ON bazaar_challenge_mac_epochs ((retired_at IS NULL))
  WHERE retired_at IS NULL;
