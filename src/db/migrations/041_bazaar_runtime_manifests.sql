CREATE TABLE bazaar_runtime_manifests (
  manifest_epoch NUMERIC(78, 0) PRIMARY KEY CHECK (manifest_epoch > 0),
  manifest_hash BYTEA NOT NULL UNIQUE CHECK (
    octet_length(manifest_hash) = 32 AND
    manifest_hash <> decode(repeat('00', 32), 'hex')
  ),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CHECK (retired_at IS NULL OR retired_at >= activated_at)
);

CREATE UNIQUE INDEX bazaar_runtime_manifests_one_active
  ON bazaar_runtime_manifests ((retired_at IS NULL))
  WHERE retired_at IS NULL;
