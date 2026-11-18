-- Hosted providers the gateway approved for sale (docs/provider-approvals.md).
-- One row per approval: a provider holds at most one current approval per
-- chain, and revoking or replacing one sets revoked_at, so every row is kept.
-- record_json is the ProviderControlProfileV1 envelope the gateway built at
-- approval, never signed; record_hash is its canonical hash. An epoch of a
-- provider and chain names one record: a later row may repeat an earlier
-- record (an approval reinstated unchanged), never give its epoch to another
-- record. Only the candidate runtime reads or writes this table: the
-- previous runtime never touches it, so no incumbent role needs a grant here,
-- and the candidate's runtime role receives one with every other standard_
-- table at start-up.
CREATE TABLE standard_provider_approvals (
  approval_id BIGSERIAL PRIMARY KEY,
  provider_agent_id TEXT NOT NULL CHECK (provider_agent_id ~ '^[1-9][0-9]{0,77}$'),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT NOT NULL CHECK (approved_by ~ '^(invite|operator):[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$'),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 128),
  record_json JSONB NOT NULL,
  record_hash BYTEA NOT NULL CHECK (octet_length(record_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= approved_at),
  CHECK (record_json->'payload'->>'providerAgentId' = provider_agent_id),
  CHECK ((record_json->>'chainId')::bigint = chain_id),
  CHECK ((record_json->'payload'->>'servicingProfileEpoch')::bigint >= 1)
);
CREATE UNIQUE INDEX standard_provider_approvals_current
  ON standard_provider_approvals (provider_agent_id, chain_id) WHERE revoked_at IS NULL;
CREATE INDEX standard_provider_approvals_provider
  ON standard_provider_approvals (provider_agent_id, chain_id, approval_id);
CREATE INDEX standard_provider_approvals_record_hash
  ON standard_provider_approvals (record_hash);

-- One record per epoch. Every writer of a provider's approvals takes this
-- advisory lock (src/providerApprovals/store.ts), so the check below sees
-- every committed row of the provider.
CREATE FUNCTION standard_provider_approval_epoch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'standard:provider-approval:'||NEW.chain_id||':'||NEW.provider_agent_id,0));
  IF EXISTS(SELECT 1 FROM standard_provider_approvals
    WHERE provider_agent_id=NEW.provider_agent_id AND chain_id=NEW.chain_id
      AND approval_id<>NEW.approval_id
      AND (record_json->'payload'->>'servicingProfileEpoch')::bigint=
        (NEW.record_json->'payload'->>'servicingProfileEpoch')::bigint
      AND record_hash<>NEW.record_hash) THEN
    RAISE EXCEPTION 'PROVIDER_APPROVAL_EPOCH_CONFLICT' USING ERRCODE='unique_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_provider_approval_epoch_guard
  BEFORE INSERT OR UPDATE OF record_json,record_hash ON standard_provider_approvals
  FOR EACH ROW EXECUTE FUNCTION standard_provider_approval_epoch_guard();
