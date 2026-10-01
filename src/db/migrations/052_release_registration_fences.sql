-- A real write, shared with the controller, invalidates stale SERIALIZABLE
-- snapshots. An advisory lock alone does not refresh a transaction snapshot.
CREATE TABLE standard_release_serialization_guards (
  guard_key TEXT PRIMARY KEY,
  generation BIGINT NOT NULL DEFAULT 1
);
CREATE FUNCTION standard_touch_release_guard(key TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO standard_release_serialization_guards(guard_key,generation) VALUES(key,1)
  ON CONFLICT(guard_key) DO UPDATE SET generation=standard_release_serialization_guards.generation+1;
END $$;
DO $release_guard_rights$
DECLARE incumbent record;
BEGIN
  FOR incumbent IN
    SELECT DISTINCT roles.rolname
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    JOIN pg_roles roles ON roles.oid=privilege.grantee
    WHERE namespace.nspname=current_schema()
      AND relation.relname IN ('standard_service_registrations','standard_orders',
        'standard_settlement_attempts','standard_provider_servicing_admissions')
      AND privilege.privilege_type IN ('INSERT','UPDATE')
      AND privilege.grantee<>relation.relowner
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %I.standard_release_serialization_guards TO %I',
      current_schema(),incumbent.rolname);
  END LOOP;
END $release_guard_rights$;

-- Additive release controls. Existing active registrations and durable money
-- records are unchanged; prior runtimes understand REJECTED pending records.
CREATE TABLE standard_registration_revision_fences (
  provider_agent_id TEXT NOT NULL,
  service_id BYTEA NOT NULL,
  target_revision BIGINT NOT NULL CHECK (target_revision BETWEEN 1 AND 9007199254740991),
  service_contract_hash BYTEA NOT NULL,
  skill_contract_set_hash BYTEA NOT NULL,
  intent_hash BYTEA NOT NULL,
  canonical_intent JSONB NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_agent_id, service_id)
);
CREATE TABLE standard_registration_fence_acks (
  intent_hash BYTEA PRIMARY KEY CHECK(octet_length(intent_hash)=32),
  canonical_intent JSONB NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE standard_service_registrations ADD COLUMN drift_since TIMESTAMPTZ;


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
      AND relation.relname IN ('standard_service_registrations')
      AND privilege.privilege_type IN ('INSERT','UPDATE')
      AND privilege.grantee<>relation.relowner
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.standard_registration_revision_fences TO %I', current_schema(), incumbent.rolname);
  END LOOP;
END $release_runtime_reads$;

-- Enforce the fence for every writer, including an overlapping older runtime
-- that knows nothing of the new control API. Row changes and fence acceptance
-- share this transaction lock; an acknowledgment cannot race a later stale
-- activation. An already-active legacy registration remains usable.
CREATE FUNCTION standard_enforce_registration_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision BIGINT; fence standard_registration_revision_fences%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.state <> 'ACTIVE' OR OLD.state='ACTIVE') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('registration-revision:' ||
    NEW.provider_agent_id || ':' || encode(NEW.service_id,'hex'),0));
  PERFORM standard_touch_release_guard('registration-revision:' || NEW.provider_agent_id || ':' || encode(NEW.service_id,'hex'));
  revision := coalesce((NEW.canonical_intent->'payload'->>'targetRevision')::bigint,0);
  IF revision < 0 OR revision > 9007199254740991 THEN
    RAISE EXCEPTION 'REGISTRATION_REVISION_INVALID';
  END IF;
  SELECT * INTO fence FROM standard_registration_revision_fences
    WHERE provider_agent_id=NEW.provider_agent_id AND service_id=NEW.service_id;
  IF FOUND AND revision < fence.target_revision THEN
    RAISE EXCEPTION 'REGISTRATION_REVISION_FENCED';
  END IF;
  IF FOUND AND revision = fence.target_revision AND (
    NEW.canonical_intent->'payload'->>'serviceContractHash' <> '0x'||encode(fence.service_contract_hash,'hex') OR
    NEW.canonical_intent->'payload'->>'skillContractSetHash' <> '0x'||encode(fence.skill_contract_set_hash,'hex')
  ) THEN RAISE EXCEPTION 'REGISTRATION_REVISION_CONFLICT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_registration_revision_guard
  BEFORE INSERT OR UPDATE OF state ON standard_service_registrations
  FOR EACH ROW EXECUTE FUNCTION standard_enforce_registration_revision();
