-- Retirement is permanent and distinct from reversible stop-sale. Shared
-- read locks leave unrelated purchases concurrent. Only retirement writes the
-- per-contract guard, invalidating a legacy SERIALIZABLE snapshot that raced it.
CREATE TABLE standard_contract_retirement_guards (
  provider_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('listing','asset-action')),
  contract_hash BYTEA NOT NULL CHECK(octet_length(contract_hash)=32),
  generation BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(provider_agent_id,kind,contract_hash)
);
CREATE TABLE standard_contract_retirements (
  provider_agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('listing','asset-action')),
  service_id BYTEA NOT NULL CHECK(octet_length(service_id)=32),
  contract_hash BYTEA NOT NULL CHECK(octet_length(contract_hash)=32),
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  provider_audience TEXT NOT NULL,
  receipt_payload JSONB NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_agent_id,kind,contract_hash)
);
CREATE FUNCTION standard_immutable_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CONTRACT_RETIREMENT_IMMUTABLE'; END $$;
CREATE TRIGGER standard_contract_retirement_immutable BEFORE UPDATE OR DELETE
  ON standard_contract_retirements FOR EACH ROW EXECUTE FUNCTION standard_immutable_retirement();

CREATE FUNCTION standard_contract_retired(provider_id TEXT, contract_kind TEXT, contract_hash_value BYTEA)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF contract_hash_value IS NULL THEN RETURN false; END IF;
  INSERT INTO standard_contract_retirement_guards(provider_agent_id,kind,contract_hash)
    VALUES(provider_id,contract_kind,contract_hash_value) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM standard_contract_retirement_guards
    WHERE provider_agent_id=provider_id AND kind=contract_kind AND contract_hash=contract_hash_value FOR SHARE;
  RETURN EXISTS(SELECT 1 FROM standard_contract_retirements
    WHERE provider_agent_id=provider_id AND kind=contract_kind AND contract_hash=contract_hash_value);
END $$;

CREATE FUNCTION standard_order_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE retired boolean;
BEGIN
  retired := standard_contract_retired(NEW.provider_agent_id,'listing',NEW.listing_manifest_hash);
  IF TG_OP='UPDATE' AND (OLD.provider_agent_id<>NEW.provider_agent_id OR OLD.listing_manifest_hash<>NEW.listing_manifest_hash) THEN
    IF standard_contract_retired(OLD.provider_agent_id,'listing',OLD.listing_manifest_hash) THEN
      RAISE EXCEPTION 'CONTRACT_RETIRED';
    END IF;
  END IF;
  IF retired THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
    IF NEW.state<>OLD.state OR NEW.state NOT IN ('FULFILLED','NOT_SETTLED') OR
      NEW.authorization_key IS DISTINCT FROM OLD.authorization_key OR
      NEW.encrypted_payment_payload IS DISTINCT FROM OLD.encrypted_payment_payload
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_order_retirement_guard BEFORE INSERT OR UPDATE ON standard_orders
  FOR EACH ROW EXECUTE FUNCTION standard_order_retirement_guard();

CREATE FUNCTION standard_order_journal_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_order standard_orders%ROWTYPE; bound_order_id TEXT;
BEGIN
  IF TG_TABLE_NAME='standard_reputation_transactions' THEN
    SELECT order_id INTO bound_order_id FROM standard_reputation_operations WHERE operation_id=NEW.operation_id;
  ELSE bound_order_id := NEW.order_id; END IF;
  IF bound_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT bound_order FROM standard_orders WHERE order_id=bound_order_id;
  IF standard_contract_retired(bound_order.provider_agent_id,'listing',bound_order.listing_manifest_hash)
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  RETURN NEW;
END $$;
DO $journal_triggers$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['standard_settlement_attempts','standard_dispatch_claims',
    'standard_capacity_reservations','standard_reputation_operations','standard_reputation_transactions',
    'standard_confirmation_preparations','standard_confirmation_preparations_v2',
    'standard_confirmation_sponsorships','standard_confirmation_sponsorships_v2','standard_security_incidents','standard_parked_authorizations'] LOOP
    EXECUTE format('CREATE TRIGGER standard_journal_retirement_guard BEFORE INSERT OR UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION standard_order_journal_retirement_guard()',table_name);
  END LOOP;
END $journal_triggers$;

CREATE FUNCTION standard_listing_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE provider_id TEXT;
BEGIN
  SELECT provider_agent_id INTO STRICT provider_id FROM standard_service_registrations WHERE registration_id=NEW.registration_id;
  IF standard_contract_retired(provider_id,'listing',NEW.runtime_commitment_hash)
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_listing_retirement_guard BEFORE INSERT OR UPDATE ON standard_service_listings
  FOR EACH ROW EXECUTE FUNCTION standard_listing_retirement_guard();
CREATE FUNCTION standard_registration_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing record;
BEGIN
  IF NEW.state NOT IN ('PREPARED','EVIDENCE_PENDING','ACTIVE') THEN RETURN NEW; END IF;
  FOR listing IN SELECT runtime_commitment_hash FROM standard_service_listings
    WHERE registration_id=NEW.registration_id AND runtime_commitment_hash IS NOT NULL ORDER BY runtime_commitment_hash LOOP
    IF standard_contract_retired(NEW.provider_agent_id,'listing',listing.runtime_commitment_hash)
      THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_registration_retirement_guard BEFORE INSERT OR UPDATE ON standard_service_registrations
  FOR EACH ROW EXECUTE FUNCTION standard_registration_retirement_guard();
CREATE FUNCTION standard_sale_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.accepting_new_orders AND standard_contract_retired(NEW.provider_agent_id,'listing',NEW.listing_manifest_hash)
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_sale_retirement_guard BEFORE INSERT OR UPDATE ON standard_sale_controls
  FOR EACH ROW EXECUTE FUNCTION standard_sale_retirement_guard();

CREATE FUNCTION standard_asset_claim_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF standard_contract_retired(NEW.provider_agent_id,'asset-action',NEW.action_definition_hash)
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_asset_claim_retirement_guard BEFORE INSERT OR UPDATE ON standard_asset_action_claims
  FOR EACH ROW EXECUTE FUNCTION standard_asset_claim_retirement_guard();

-- A later epoch may add new ids, never resurrect a retired definition.
-- Catalog rows are admitted before background target activation.
CREATE FUNCTION standard_admission_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE catalog JSONB; action JSONB;
BEGIN
  IF NOT NEW.current THEN RETURN NEW; END IF;
  -- Match existing epoch writers before acquiring per-definition locks.
  -- A genuine generation write invalidates stale REPEATABLE READ snapshots.
  PERFORM pg_advisory_xact_lock(hashtextextended('standard:servicing-admission:'||NEW.provider_agent_id,0));
  PERFORM standard_touch_release_guard('standard:servicing-admission:'||NEW.provider_agent_id);
  SELECT canonical_json INTO catalog FROM standard_rail_artifacts
    WHERE artifact_hash=decode(substring(NEW.canonical_admission->'payload'->>'actionCatalogHash',3),'hex');
  IF catalog IS NULL THEN
    IF EXISTS(SELECT 1 FROM standard_contract_retirements WHERE provider_agent_id=NEW.provider_agent_id AND kind='asset-action')
      THEN RAISE EXCEPTION 'RETIREMENT_CATALOG_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  FOR action IN SELECT value FROM jsonb_array_elements(catalog->'payload'->'actions') ORDER BY value->>'actionDefinitionHash' LOOP
    IF standard_contract_retired(NEW.provider_agent_id,'asset-action',
      decode(substring(action->>'actionDefinitionHash',3),'hex'))
      THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_admission_retirement_guard BEFORE INSERT OR UPDATE ON standard_provider_servicing_admissions
  FOR EACH ROW EXECUTE FUNCTION standard_admission_retirement_guard();

-- Install triggers before backfill while migration table locks exclude writers.
INSERT INTO standard_contract_retirement_guards(provider_agent_id,kind,contract_hash)
SELECT provider_agent_id,'listing',listing_manifest_hash FROM standard_orders
UNION SELECT r.provider_agent_id,'listing',l.runtime_commitment_hash
  FROM standard_service_registrations r JOIN standard_service_listings l USING(registration_id) WHERE l.runtime_commitment_hash IS NOT NULL
UNION SELECT provider_agent_id,'asset-action',action_definition_hash FROM standard_asset_action_claims
ON CONFLICT DO NOTHING;

-- An incumbent may continue before the candidate configures its runtime role.
-- Grant trigger dependencies only, never the authority to issue a retirement.
DO $legacy_read_rights$
DECLARE incumbent record;
BEGIN
  FOR incumbent IN SELECT DISTINCT roles.rolname FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) privilege
    JOIN pg_roles roles ON roles.oid=privilege.grantee
    WHERE namespace.nspname=current_schema() AND relation.relname='standard_orders'
      AND privilege.privilege_type IN ('INSERT','UPDATE') AND privilege.grantee<>relation.relowner
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %I.standard_contract_retirement_guards TO %I',current_schema(),incumbent.rolname);
    EXECUTE format('GRANT SELECT ON TABLE %I.standard_contract_retirements TO %I',current_schema(),incumbent.rolname);
  END LOOP;
END $legacy_read_rights$;
