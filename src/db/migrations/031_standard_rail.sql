-- Complete standard Exact-EVM rail. This is an intentionally destructive
-- preproduction cutover after the native authorization drain: obsolete native
-- payment, settlement, confirmation, projection, and reputation state is not
-- retained in the target runtime database.

DROP TABLE IF EXISTS
  settlement_sponsorship_buckets,
  confirmation_sponsorship_buckets,
  buyer_confirmation_submissions,
  facilitator_transactions,
  task_mappings,
  settlement_screening_events,
  reputation_mirrors,
  chain_indexer_state,
  chain_events,
  buyer_identities,
  skill_embeddings,
  payment_challenges
CASCADE;

CREATE TABLE standard_rail_artifacts (
  artifact_hash BYTEA PRIMARY KEY CHECK (octet_length(artifact_hash) = 32),
  artifact_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  environment TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  epoch BIGINT,
  canonical_json JSONB NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_before TIMESTAMPTZ NOT NULL,
  recovery_valid_before TIMESTAMPTZ
);

CREATE TABLE standard_orders (
  order_id TEXT PRIMARY KEY,
  order_handle TEXT NOT NULL UNIQUE,
  handle_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(handle_hash) = 32),
  state TEXT NOT NULL CHECK (state IN (
    'DRAFT','CHALLENGE_ISSUED','ATTEMPT_OPENED','VERIFIED','VERIFY_REJECTED',
    'SETTLE_INVOKED','FACILITATOR_CONFIRMED','SETTLEMENT_AMBIGUOUS',
    'SETTLEMENT_FAILED','EXTERNAL_OR_UNPROVEN_DEPOSIT','DEPOSIT_FINAL',
    'RELEASE_FINAL','DISPATCH_STARTED','DISPATCHED','DISPATCH_AMBIGUOUS',
    'FULFILLED','PROVIDER_FAILED','KYC_REQUIRED','LEGAL_HOLD','REFUND_DUE',
    'REFUND_RESERVED','REFUND_INVOKED','REFUND_AMBIGUOUS','REFUNDED','NO_REFUND'
  )),
  provider_agent_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  binding_profile TEXT NOT NULL
    CHECK (binding_profile IN ('stock-fixed-v1', 'recipe-bound-v1')),
  listing_manifest_hash BYTEA NOT NULL CHECK (octet_length(listing_manifest_hash) = 32),
  provider_offer_hash BYTEA NOT NULL CHECK (octet_length(provider_offer_hash) = 32),
  canonical_listing JSONB NOT NULL,
  quote_hash BYTEA NOT NULL CHECK (octet_length(quote_hash) = 32),
  canonical_quote JSONB NOT NULL,
  canonical_request_hash BYTEA NOT NULL CHECK (octet_length(canonical_request_hash) = 32),
  canonical_request JSONB NOT NULL,
  attachment_set_hash BYTEA CHECK (attachment_set_hash IS NULL OR octet_length(attachment_set_hash) = 32),
  order_nonce BYTEA NOT NULL UNIQUE CHECK (octet_length(order_nonce) = 32),
  authorization_key BYTEA UNIQUE CHECK (authorization_key IS NULL OR octet_length(authorization_key) = 32),
  payment_payload_hash BYTEA CHECK (payment_payload_hash IS NULL OR octet_length(payment_payload_hash) = 32),
  payer TEXT,
  gross_amount NUMERIC(78,0) NOT NULL CHECK (gross_amount > 0),
  provider_net_amount NUMERIC(78,0) CHECK (provider_net_amount IS NULL OR provider_net_amount > 0),
  daski_commission_amount NUMERIC(78,0) CHECK (daski_commission_amount IS NULL OR daski_commission_amount > 0),
  encrypted_payment_payload BYTEA,
  settlement_tx_hash TEXT,
  deposit_evidence_hash BYTEA CHECK (deposit_evidence_hash IS NULL OR octet_length(deposit_evidence_hash) = 32),
  release_tx_hash TEXT,
  release_evidence_hash BYTEA CHECK (release_evidence_hash IS NULL OR octet_length(release_evidence_hash) = 32),
  provider_task_id TEXT,
  runtime_epoch BIGINT NOT NULL,
  rail_epoch BIGINT NOT NULL,
  listing_epoch BIGINT NOT NULL,
  lease_owner TEXT,
  lease_fence BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (provider_net_amount IS NULL AND daski_commission_amount IS NULL) OR
    (provider_net_amount IS NOT NULL AND daski_commission_amount IS NOT NULL AND
      provider_net_amount + daski_commission_amount = gross_amount)
  )
);

CREATE INDEX standard_orders_work_idx
  ON standard_orders(state, lease_until, updated_at);
CREATE INDEX standard_orders_listing_idx
  ON standard_orders(provider_agent_id, outcome_id, created_at DESC);

CREATE TABLE standard_rail_receipts (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  receipt_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(receipt_hash) = 32),
  canonical_receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_capacity_reservations (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  listing_manifest_hash BYTEA NOT NULL CHECK (octet_length(listing_manifest_hash) = 32),
  state TEXT NOT NULL CHECK (state IN ('open','released')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE INDEX standard_capacity_open_idx
  ON standard_capacity_reservations(listing_manifest_hash) WHERE state='open';

CREATE TABLE standard_order_transitions (
  transition_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  evidence_hash BYTEA CHECK (evidence_hash IS NULL OR octet_length(evidence_hash) = 32),
  fence BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_settlement_attempts (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  attempt_id TEXT NOT NULL UNIQUE,
  facilitator_profile_hash BYTEA NOT NULL CHECK (octet_length(facilitator_profile_hash) = 32),
  verify_invoked_at TIMESTAMPTZ,
  verify_response_hash BYTEA,
  settle_invoked_at TIMESTAMPTZ,
  settle_response_hash BYTEA,
  settlement_tx_hash TEXT,
  terminal_kind TEXT CHECK (terminal_kind IS NULL OR terminal_kind IN ('verify_rejected','confirmed')),
  CHECK (verify_response_hash IS NULL OR octet_length(verify_response_hash) = 32),
  CHECK (settle_response_hash IS NULL OR octet_length(settle_response_hash) = 32)
);

CREATE TABLE standard_chain_evidence (
  evidence_hash BYTEA PRIMARY KEY CHECK (octet_length(evidence_hash) = 32),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('deposit', 'release', 'refund')),
  chain_id BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  transaction_index INTEGER NOT NULL CHECK (transaction_index >= 0),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  source_fingerprints JSONB NOT NULL,
  canonical_evidence JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, evidence_kind, transaction_hash, log_index)
);

CREATE TABLE standard_dispatch_claims (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  dispatch_nonce BYTEA NOT NULL UNIQUE CHECK (octet_length(dispatch_nonce) = 32),
  dispatch_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(dispatch_hash) = 32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  invocation_state TEXT NOT NULL CHECK (invocation_state IN ('invoked','accepted')),
  provider_task_id TEXT,
  response_hash BYTEA CHECK (response_hash IS NULL OR octet_length(response_hash) = 32),
  canonical_dispatch JSONB NOT NULL,
  canonical_request JSONB NOT NULL,
  invoked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE standard_refund_exposure (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  provider_reservation_id BYTEA NOT NULL UNIQUE CHECK (octet_length(provider_reservation_id) = 32),
  daski_reservation_id BYTEA NOT NULL UNIQUE CHECK (octet_length(daski_reservation_id) = 32),
  token TEXT NOT NULL,
  payer TEXT NOT NULL,
  gross_amount NUMERIC(78,0) NOT NULL CHECK (gross_amount > 0),
  provider_reserved NUMERIC(78,0) NOT NULL CHECK (provider_reserved >= 0),
  daski_reserved NUMERIC(78,0) NOT NULL CHECK (daski_reserved >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'reserved','refund_due','invoked','ambiguous','refunded','released','legal_hold'
  )),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE TABLE standard_refund_attempts (
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  leg TEXT NOT NULL CHECK (leg='gross'),
  attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
  intent_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(intent_hash) = 32),
  canonical_intent JSONB NOT NULL,
  raw_transaction TEXT,
  expected_transaction_hash TEXT,
  transaction_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('invoked','broadcast','ambiguous','refunded')),
  invoked_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (order_id, leg, attempt_sequence)
);

CREATE TABLE standard_action_nonces (
  payer TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  action TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payer, nonce)
);

CREATE INDEX standard_action_nonces_consumed_idx ON standard_action_nonces(consumed_at);

CREATE TABLE standard_action_challenges (
  nonce BYTEA PRIMARY KEY CHECK (octet_length(nonce) = 32),
  order_id TEXT REFERENCES standard_orders(order_id),
  action TEXT NOT NULL,
  canonical_request_hash BYTEA NOT NULL CHECK (octet_length(canonical_request_hash) = 32),
  absolute_resource_uri TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  valid_before TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX standard_action_challenges_expiry_idx
  ON standard_action_challenges(valid_before) WHERE consumed_at IS NULL;

CREATE INDEX standard_action_challenges_consumed_idx
  ON standard_action_challenges(consumed_at) WHERE consumed_at IS NOT NULL;

CREATE TABLE standard_upload_sessions (
  session_hash BYTEA PRIMARY KEY CHECK (octet_length(session_hash) = 32),
  audience TEXT NOT NULL,
  policy JSONB NOT NULL,
  bound_order_id TEXT REFERENCES standard_orders(order_id),
  canonical_request_hash BYTEA CHECK (canonical_request_hash IS NULL OR octet_length(canonical_request_hash) = 32),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_upload_attempts (
  storage_key TEXT PRIMARY KEY,
  session_hash BYTEA NOT NULL CHECK (octet_length(session_hash) = 32),
  object_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_upload_objects (
  object_id TEXT NOT NULL,
  session_hash BYTEA NOT NULL REFERENCES standard_upload_sessions(session_hash),
  content_hash BYTEA NOT NULL CHECK (octet_length(content_hash) = 32),
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  storage_key TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_hash, object_id),
  UNIQUE (session_hash, content_hash)
);
