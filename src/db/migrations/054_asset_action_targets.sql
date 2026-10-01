CREATE TABLE standard_asset_action_targets (
  provider_agent_id TEXT PRIMARY KEY,
  target_epoch BIGINT NOT NULL CHECK(target_epoch BETWEEN 1 AND 9007199254740991),
  request_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE standard_asset_action_target_requests (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Existing admissions establish the installation baseline. Future carried
-- artifacts require the authenticated CAS even when an old binary writes.
INSERT INTO standard_asset_action_targets(provider_agent_id,target_epoch)
SELECT provider_agent_id,(canonical_admission->'payload'->>'actionCatalogEpoch')::bigint
FROM standard_provider_servicing_admissions WHERE current;


-- An incumbent already holds these legacy table privileges. Install only the
-- control reads its new invoker triggers need, in this migration transaction;
-- a candidate that fails before runtime configuration must not break it.
DO $release_runtime_reads$
DECLARE incumbent record;
BEGIN
  FOR incumbent IN
    SELECT DISTINCT roles.rolname
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    JOIN pg_roles roles ON roles.oid=privilege.grantee
    WHERE namespace.nspname=current_schema()
      AND relation.relname IN ('standard_provider_servicing_admissions')
      AND privilege.privilege_type IN ('INSERT','UPDATE')
      AND privilege.grantee<>relation.relowner
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.standard_asset_action_targets TO %I', current_schema(), incumbent.rolname);
  END LOOP;
END $release_runtime_reads$;

CREATE FUNCTION standard_fence_asset_action_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE desired bigint; epoch bigint; profile_epoch bigint; previous_profile_epoch bigint;
BEGIN
  IF NOT NEW.current THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('standard:servicing-admission:'||NEW.provider_agent_id,0));
  PERFORM standard_touch_release_guard('standard:servicing-admission:'||NEW.provider_agent_id);
  epoch := (NEW.canonical_admission->'payload'->>'actionCatalogEpoch')::bigint;
  profile_epoch := (NEW.canonical_admission->'payload'->>'servicingProfileEpoch')::bigint;
  SELECT target_epoch INTO desired FROM standard_asset_action_targets WHERE provider_agent_id=NEW.provider_agent_id;
  IF desired IS NULL THEN
    IF profile_epoch<>1 THEN RAISE EXCEPTION 'ASSET_ACTION_TARGET_REQUIRED'; END IF;
    -- A legacy bootstrap may create only profile 1, never a target control.
    desired := epoch;
  END IF;
  IF epoch>desired THEN RAISE EXCEPTION 'ASSET_ACTION_TARGET_FENCED'; END IF;
  SELECT max((canonical_admission->'payload'->>'servicingProfileEpoch')::bigint)
    INTO previous_profile_epoch FROM standard_provider_servicing_admissions WHERE provider_agent_id=NEW.provider_agent_id;
  IF profile_epoch<coalesce(previous_profile_epoch,profile_epoch) THEN
    RAISE EXCEPTION 'ASSET_ACTION_TARGET_DOWNGRADE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_asset_action_target_guard
  BEFORE INSERT OR UPDATE OF current ON standard_provider_servicing_admissions
  FOR EACH ROW EXECUTE FUNCTION standard_fence_asset_action_target();
