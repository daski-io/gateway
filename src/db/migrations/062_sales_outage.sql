-- One sales outage switch for the environment this database serves. An active
-- outage stops new challenges, purchases and settlement invocations for every
-- listing until its end time passes; nothing writes the row when it expires.
CREATE TABLE standard_sales_outage (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  active BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  since TIMESTAMPTZ,
  until TIMESTAMPTZ,
  set_by TEXT,
  revision BIGINT NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(NOT active OR (reason IS NOT NULL AND since IS NOT NULL AND until>since AND set_by IS NOT NULL))
);
-- Admission locks this row, so it exists before any outage starts.
INSERT INTO standard_sales_outage DEFAULT VALUES;
CREATE TABLE standard_sales_outage_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  revision BIGINT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('start','extend','end')),
  environment TEXT NOT NULL,
  reason TEXT,
  since TIMESTAMPTZ,
  until TIMESTAMPTZ,
  previous_until TIMESTAMPTZ,
  set_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The incumbent runtime calls the function below from its admission triggers
-- before the candidate configures runtime privileges. FOR SHARE needs UPDATE.
DO $sales_outage_reads$
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
    EXECUTE format('GRANT SELECT,UPDATE ON TABLE %I.standard_sales_outage TO %I', current_schema(), incumbent.rolname);
  END LOOP;
END $sales_outage_reads$;

-- Every admission and settlement-invocation trigger, of the current and of an
-- overlapping prior runtime, passes here. Locking the outage row orders it
-- with a concurrent start: a start waits for admissions that locked first, and
-- an admission that waited behind a start reads it. A REPEATABLE READ or
-- SERIALIZABLE snapshot older than the start fails to lock and retries. The
-- message stays SALE_SUSPENDED, which prior runtimes already refuse with; the
-- detail tells the current runtime it is the temporary outage.
CREATE OR REPLACE FUNCTION standard_assert_sale_open(provider_id TEXT, listing_hash BYTEA) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE outage standard_sales_outage%ROWTYPE;
BEGIN
  SELECT * INTO outage FROM standard_sales_outage FOR SHARE;
  IF FOUND AND outage.active AND outage.until>now() THEN
    RAISE EXCEPTION 'SALE_SUSPENDED' USING DETAIL='SALES_PAUSED',
      HINT=json_build_object('reason',outage.reason,'since',outage.since,'until',outage.until)::text;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('release-sale:'||encode(listing_hash,'hex'),0));
  PERFORM 1 FROM standard_release_serialization_guards
    WHERE guard_key='release-sale:'||encode(listing_hash,'hex') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SALE_GUARD_MISSING'; END IF;
  IF EXISTS(SELECT 1 FROM standard_sale_controls
    WHERE provider_agent_id=provider_id AND listing_manifest_hash=listing_hash AND NOT accepting_new_orders) THEN
    RAISE EXCEPTION 'SALE_SUSPENDED';
  END IF;
END $$;
