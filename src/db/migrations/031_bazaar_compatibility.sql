CREATE TABLE bazaar_listing_bindings (
  pay_to BYTEA PRIMARY KEY CHECK (octet_length(pay_to) = 20),
  listing_commitment BYTEA NOT NULL UNIQUE
    CHECK (octet_length(listing_commitment) = 32),
  listing_epoch BYTEA NOT NULL UNIQUE CHECK (octet_length(listing_epoch) = 32),
  provider_agent_id NUMERIC(78, 0) NOT NULL CHECK (provider_agent_id > 0),
  outcome_id BYTEA NOT NULL CHECK (octet_length(outcome_id) = 32),
  resource TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bazaar_listing_offers (
  offer_id BYTEA PRIMARY KEY CHECK (octet_length(offer_id) = 32),
  offer_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(offer_hash) = 32),
  listing_commitment BYTEA NOT NULL REFERENCES bazaar_listing_bindings(listing_commitment),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bazaar_orders (
  order_record_id BYTEA PRIMARY KEY CHECK (octet_length(order_record_id) = 32),
  order_handle TEXT NOT NULL UNIQUE CHECK (order_handle ~ '^[A-Za-z0-9_-]{43}$'),
  authorization_digest BYTEA NOT NULL UNIQUE
    CHECK (octet_length(authorization_digest) = 32),
  authorization_signature_digest BYTEA NOT NULL
    CHECK (octet_length(authorization_signature_digest) = 32),
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  token BYTEA NOT NULL CHECK (octet_length(token) = 20),
  payer BYTEA NOT NULL CHECK (octet_length(payer) = 20),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  provider_agent_id NUMERIC(78, 0) NOT NULL CHECK (provider_agent_id > 0),
  listing_epoch BYTEA NOT NULL CHECK (octet_length(listing_epoch) = 32),
  listing_commitment BYTEA NOT NULL CHECK (octet_length(listing_commitment) = 32),
  outcome_id BYTEA NOT NULL CHECK (octet_length(outcome_id) = 32),
  resource TEXT NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  offer_hash BYTEA NOT NULL CHECK (octet_length(offer_hash) = 32),
  gross_amount NUMERIC(78, 0) NOT NULL CHECK (gross_amount > 0),
  pay_to BYTEA NOT NULL CHECK (octet_length(pay_to) = 20),
  authorization_valid_before NUMERIC(78, 0) NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'verify_rejected', 'verify_ambiguous', 'settle_started',
    'settle_rejected', 'settle_ambiguous', 'settle_confirmed',
    'evidence_rejected', 'settled', 'dispatch_started', 'dispatch_failed',
    'dispatched'
  )),
  processing_lease_token UUID,
  processing_lease_owner TEXT CHECK (
    processing_lease_owner IS NULL OR
    length(processing_lease_owner) BETWEEN 1 AND 128
  ),
  processing_lease_expires_at TIMESTAMPTZ,
  settlement_transaction BYTEA UNIQUE
    CHECK (settlement_transaction IS NULL OR octet_length(settlement_transaction) = 32),
  facilitator_payer BYTEA
    CHECK (facilitator_payer IS NULL OR octet_length(facilitator_payer) = 20),
  verify_extension_hash BYTEA
    CHECK (verify_extension_hash IS NULL OR octet_length(verify_extension_hash) = 32),
  verify_bazaar_status TEXT CHECK (
    verify_bazaar_status IS NULL OR
    verify_bazaar_status IN ('success', 'processing', 'rejected')
  ),
  settle_extension_hash BYTEA
    CHECK (settle_extension_hash IS NULL OR octet_length(settle_extension_hash) = 32),
  settle_bazaar_status TEXT CHECK (
    settle_bazaar_status IS NULL OR
    settle_bazaar_status IN ('success', 'processing', 'rejected')
  ),
  bazaar_rejected_reason_hash BYTEA CHECK (
    bazaar_rejected_reason_hash IS NULL OR
    octet_length(bazaar_rejected_reason_hash) = 32
  ),
  task_id TEXT,
  task_id_hash BYTEA CHECK (task_id_hash IS NULL OR octet_length(task_id_hash) = 32),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, token, payer, nonce),
  CHECK (
    (
      state IN ('claimed', 'settle_started', 'settle_confirmed', 'settled',
                'dispatch_started')
      AND processing_lease_token IS NOT NULL
      AND processing_lease_owner IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
    )
    OR (
      state NOT IN ('claimed', 'settle_started', 'settle_confirmed', 'settled',
                    'dispatch_started')
      AND processing_lease_token IS NULL
      AND processing_lease_owner IS NULL
      AND processing_lease_expires_at IS NULL
    )
  ),
  CHECK (
    state NOT IN ('settle_confirmed', 'settled', 'dispatch_started',
                  'dispatch_failed', 'dispatched')
    OR settlement_transaction IS NOT NULL
  )
);

CREATE INDEX bazaar_orders_state_idx ON bazaar_orders (state, updated_at);
CREATE INDEX bazaar_orders_recovery_idx
  ON bazaar_orders (processing_lease_expires_at, updated_at)
  WHERE state IN ('claimed', 'settle_started', 'settle_confirmed', 'settled',
                  'dispatch_started');

CREATE TABLE bazaar_lifecycle_consumptions (
  order_record_id BYTEA NOT NULL REFERENCES bazaar_orders(order_record_id),
  challenge_nonce BYTEA NOT NULL CHECK (octet_length(challenge_nonce) = 32),
  action TEXT NOT NULL CHECK (action IN (
    'ORDER_STATUS', 'ARTIFACT_GET', 'SUPPORT_MESSAGE'
  )),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_record_id, challenge_nonce)
);
