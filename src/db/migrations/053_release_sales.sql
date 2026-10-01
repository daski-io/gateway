CREATE TABLE standard_sale_controls (
  provider_agent_id TEXT NOT NULL,
  service_id BYTEA NOT NULL CHECK(octet_length(service_id)=32),
  listing_manifest_hash BYTEA NOT NULL CHECK(octet_length(listing_manifest_hash)=32),
  revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  request_id TEXT NOT NULL,
  accepting_new_orders BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_agent_id,service_id,listing_manifest_hash)
);
CREATE TABLE standard_sale_control_requests (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE standard_parked_authorizations (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  sale_revision BIGINT NOT NULL,
  parked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_at TIMESTAMPTZ,
  observation JSONB,
  finality_evidence JSONB
);


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
      AND relation.relname IN ('standard_orders','standard_settlement_attempts')
      AND privilege.privilege_type IN ('INSERT','UPDATE')
      AND privilege.grantee<>relation.relowner
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE %I.standard_sale_controls TO %I', current_schema(), incumbent.rolname);
    EXECUTE format('GRANT SELECT ON TABLE %I.standard_parked_authorizations TO %I', current_schema(), incumbent.rolname);
  END LOOP;
END $release_runtime_reads$;

-- These triggers constrain legacy code too. A new-process check alone cannot
-- prevent an overlapping old process from admitting a settlement invocation.
CREATE FUNCTION standard_assert_sale_open(provider_id TEXT, listing_hash BYTEA) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('release-sale:'||encode(listing_hash,'hex'),0));
  PERFORM standard_touch_release_guard('release-sale:'||encode(listing_hash,'hex'));
  IF EXISTS(SELECT 1 FROM standard_sale_controls
    WHERE provider_agent_id=provider_id AND listing_manifest_hash=listing_hash AND NOT accepting_new_orders) THEN
    RAISE EXCEPTION 'SALE_SUSPENDED';
  END IF;
END $$;
CREATE FUNCTION standard_fence_settlement_invocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bound_order standard_orders%ROWTYPE;
BEGIN
  IF OLD.settle_invoked_at IS NULL AND NEW.settle_invoked_at IS NOT NULL THEN
    SELECT * INTO STRICT bound_order FROM standard_orders WHERE order_id=NEW.order_id;
    PERFORM standard_assert_sale_open(bound_order.provider_agent_id,bound_order.listing_manifest_hash);
    IF EXISTS(SELECT 1 FROM standard_parked_authorizations WHERE order_id=NEW.order_id) THEN
      RAISE EXCEPTION 'AUTHORIZATION_PARKED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_settlement_sale_guard
  BEFORE UPDATE OF settle_invoked_at ON standard_settlement_attempts
  FOR EACH ROW EXECUTE FUNCTION standard_fence_settlement_invocation();
CREATE FUNCTION standard_fence_order_admission() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ATTEMPT_OPENED' AND OLD.state='CHALLENGE_ISSUED' THEN
    PERFORM standard_assert_sale_open(NEW.provider_agent_id,NEW.listing_manifest_hash);
  END IF;
  IF NEW.state='NOT_SETTLED' AND OLD.state<>'NOT_SETTLED' AND EXISTS(
    SELECT 1 FROM standard_parked_authorizations WHERE order_id=NEW.order_id AND finality_evidence IS NULL
  ) THEN RAISE EXCEPTION 'PARKED_AUTHORIZATION_FINALITY_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER standard_order_sale_guard
  BEFORE UPDATE OF state ON standard_orders
  FOR EACH ROW EXECUTE FUNCTION standard_fence_order_admission();
