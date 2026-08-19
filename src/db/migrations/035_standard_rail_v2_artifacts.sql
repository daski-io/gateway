-- Admit the V2 chain-evidence policy and listing artifacts while keeping
-- unknown schema versions fail-closed.
ALTER TABLE standard_rail_artifacts
  DROP CONSTRAINT standard_rail_artifacts_schema_version_check;

ALTER TABLE standard_rail_artifacts
  ADD CONSTRAINT standard_rail_artifacts_schema_version_check
  CHECK (schema_version IN (1, 2));
