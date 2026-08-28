-- Provider-authenticated, service-first catalog registration. This storage is
-- dark until DYNAMIC_SERVICE_REGISTRATION_ENABLED is explicitly enabled.
CREATE TABLE standard_service_registrations (
  registration_id UUID PRIMARY KEY,
  provider_agent_id TEXT NOT NULL CHECK (
    provider_agent_id ~ '^(0|[1-9][0-9]{0,77})$'
  ),
  service_id BYTEA NOT NULL CHECK (octet_length(service_id) = 32),
  service_slug TEXT NOT NULL CHECK (
    length(service_slug) BETWEEN 1 AND 64
    AND service_slug ~ '^[a-z0-9][a-z0-9-]*$'
  ),
  service_version TEXT NOT NULL CHECK (length(service_version) BETWEEN 1 AND 32),
  supersedes_registration_id UUID REFERENCES standard_service_registrations(registration_id),
  agent_card_url TEXT NOT NULL,
  service_wallet TEXT NOT NULL CHECK (service_wallet ~ '^0x[0-9a-f]{40}$'),
  provider_owner TEXT NOT NULL CHECK (provider_owner ~ '^0x[0-9a-f]{40}$'),
  provider_agent_wallet TEXT NOT NULL CHECK (provider_agent_wallet ~ '^0x[0-9a-f]{40}$'),
  provider_signer TEXT NOT NULL CHECK (provider_signer ~ '^0x[0-9a-f]{40}$'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  provider_payee TEXT NOT NULL CHECK (provider_payee ~ '^0x[0-9a-f]{40}$'),
  registration_nonce BYTEA NOT NULL CHECK (octet_length(registration_nonce) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  canonical_intent JSONB NOT NULL,
  prepared_json JSONB NOT NULL,
  card_json JSONB NOT NULL,
  card_hash BYTEA NOT NULL CHECK (octet_length(card_hash) = 32),
  skill_contract_set_hash BYTEA NOT NULL CHECK (octet_length(skill_contract_set_hash) = 32),
  state TEXT NOT NULL CHECK (state IN (
    'PREPARED','EVIDENCE_PENDING','ACTIVE','SUPERSEDED','REJECTED'
  )),
  marketplace_enabled BOOLEAN NOT NULL,
  marketplace_enabled_by TEXT NOT NULL DEFAULT 'environment-default',
  marketplace_enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  card_accepting_orders BOOLEAN NOT NULL,
  chain_active BOOLEAN NOT NULL DEFAULT false,
  registration_healthy BOOLEAN NOT NULL DEFAULT false,
  evidence_nonce BYTEA CHECK (
    evidence_nonce IS NULL OR octet_length(evidence_nonce) = 32
  ),
  canonical_evidence JSONB,
  refresh_failures INTEGER NOT NULL DEFAULT 0 CHECK (refresh_failures >= 0),
  last_refresh_error_code TEXT,
  last_refresh_attempted_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_agent_id, idempotency_key),
  UNIQUE (provider_agent_id, registration_nonce),
  UNIQUE (provider_agent_id, evidence_nonce)
);

CREATE UNIQUE INDEX standard_service_registrations_active_service
  ON standard_service_registrations(service_id)
  WHERE state='ACTIVE';

CREATE UNIQUE INDEX standard_service_registrations_pending_service
  ON standard_service_registrations(service_id)
  WHERE state IN ('PREPARED','EVIDENCE_PENDING');

CREATE INDEX standard_service_registrations_public_idx
  ON standard_service_registrations(updated_at DESC)
  WHERE state='ACTIVE' AND marketplace_enabled AND card_accepting_orders
    AND chain_active AND registration_healthy;

CREATE INDEX standard_service_registrations_refresh_idx
  ON standard_service_registrations(last_refreshed_at NULLS FIRST)
  WHERE state='ACTIVE';

CREATE TABLE standard_service_listings (
  listing_id UUID PRIMARY KEY,
  registration_id UUID NOT NULL REFERENCES standard_service_registrations(registration_id),
  listing_key BYTEA NOT NULL CHECK (octet_length(listing_key) = 32),
  skill_id TEXT NOT NULL CHECK (
    length(skill_id) BETWEEN 1 AND 96
    AND skill_id ~ '^[a-z0-9][a-z0-9-]*$'
  ),
  skill_contract_hash BYTEA NOT NULL CHECK (octet_length(skill_contract_hash) = 32),
  payment_required BOOLEAN NOT NULL,
  accepting_new_orders BOOLEAN NOT NULL,
  deployment_required BOOLEAN NOT NULL,
  splitter_address TEXT CHECK (
    splitter_address IS NULL OR splitter_address ~ '^0x[0-9a-f]{40}$'
  ),
  splitter_transaction_hash TEXT CHECK (
    splitter_transaction_hash IS NULL OR splitter_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  preparation_json JSONB,
  control_profile_json JSONB,
  state TEXT NOT NULL CHECK (state IN ('PREPARED','ACTIVE','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (registration_id, skill_id),
  UNIQUE (registration_id, listing_key),
  CHECK (
    (payment_required AND accepting_new_orders
      AND splitter_address IS NOT NULL AND preparation_json IS NOT NULL)
    OR
    ((NOT payment_required OR NOT accepting_new_orders)
      AND splitter_address IS NULL AND preparation_json IS NULL
      AND NOT deployment_required)
  ),
  CHECK (NOT deployment_required OR (payment_required AND accepting_new_orders))
);

CREATE INDEX standard_service_listings_registration_idx
  ON standard_service_listings(registration_id, skill_id);
