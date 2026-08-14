DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM standard_orders) THEN
    RAISE EXCEPTION 'standard wallet cutover requires an empty preproduction order table';
  END IF;
END $$;

ALTER TABLE standard_orders DROP CONSTRAINT standard_orders_state_check;
ALTER TABLE standard_orders ADD CONSTRAINT standard_orders_state_check CHECK (state IN (
  'DRAFT','CHALLENGE_ISSUED','ATTEMPT_OPENED','VERIFIED','VERIFY_REJECTED',
  'SETTLE_INVOKED','FACILITATOR_CONFIRMED','SETTLEMENT_AMBIGUOUS',
  'SETTLEMENT_FAILED','EXTERNAL_OR_UNPROVEN_DEPOSIT','DEPOSIT_FINAL',
  'RELEASE_FINAL','DISPATCH_STARTED','DISPATCHED','DISPATCH_AMBIGUOUS',
  'FULFILLED','PROVIDER_FAILED','INPUT_REQUIRED','LEGAL_HOLD','REFUND_DUE',
  'REFUND_RESERVED','REFUND_INVOKED','REFUND_AMBIGUOUS','REFUNDED','NO_REFUND'
));

ALTER TABLE standard_orders ADD COLUMN order_key BYTEA NOT NULL
  CHECK (octet_length(order_key)=32);

CREATE INDEX standard_orders_payer_created_idx
  ON standard_orders (lower(payer), created_at DESC, order_id DESC)
  WHERE payer IS NOT NULL;

CREATE TABLE standard_wallet_action_challenges (
  nonce BYTEA PRIMARY KEY CHECK (octet_length(nonce)=32),
  client_key_hash BYTEA NOT NULL CHECK (octet_length(client_key_hash)=32),
  payer TEXT NOT NULL,
  action_hash BYTEA NOT NULL CHECK (octet_length(action_hash)=32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  canonical_authorization JSONB NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  valid_before TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE standard_wallet_action_nonces (
  payer TEXT NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=32),
  authorization_hash BYTEA NOT NULL CHECK (octet_length(authorization_hash)=32),
  operation_hash BYTEA NOT NULL CHECK (octet_length(operation_hash)=32),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (payer, nonce)
);

CREATE INDEX standard_wallet_challenges_expiry_idx
  ON standard_wallet_action_challenges(valid_before) WHERE consumed_at IS NULL;

-- Old order-action challenges cannot be authorized under this destructive
-- preproduction cutover and must not survive into the wallet-native release.
DELETE FROM standard_action_challenges;
ALTER TABLE standard_action_challenges ADD COLUMN client_key_hash BYTEA NOT NULL
  CHECK (octet_length(client_key_hash)=32);
CREATE INDEX standard_action_challenges_client_expiry_idx
  ON standard_action_challenges(client_key_hash,valid_before)
  WHERE consumed_at IS NULL;

CREATE TABLE standard_provider_servicing_admissions (
  provider_agent_id TEXT NOT NULL,
  admission_hash BYTEA PRIMARY KEY CHECK (octet_length(admission_hash)=32),
  profile_hash BYTEA NOT NULL CHECK (octet_length(profile_hash)=32),
  canonical_admission JSONB NOT NULL,
  current BOOLEAN NOT NULL DEFAULT false,
  valid_before TIMESTAMPTZ NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX standard_provider_servicing_current_idx
  ON standard_provider_servicing_admissions(provider_agent_id) WHERE current;

CREATE TABLE standard_asset_action_claims (
  execution_id BYTEA PRIMARY KEY CHECK (octet_length(execution_id)=32),
  payer TEXT NOT NULL,
  provider_agent_id TEXT NOT NULL,
  service_id BYTEA NOT NULL CHECK (octet_length(service_id)=32),
  operation TEXT NOT NULL CHECK (operation IN ('use','confirm','cancel','recover')),
  staged_execution_id BYTEA CHECK (
    staged_execution_id IS NULL OR octet_length(staged_execution_id)=32
  ),
  wallet_authorization_hash BYTEA NOT NULL CHECK (octet_length(wallet_authorization_hash)=32),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
  provider_control_profile_hash BYTEA NOT NULL CHECK (octet_length(provider_control_profile_hash)=32),
  servicing_admission_hash BYTEA NOT NULL CHECK (octet_length(servicing_admission_hash)=32),
  action_catalog_hash BYTEA NOT NULL CHECK (octet_length(action_catalog_hash)=32),
  action_catalog_schema_hash BYTEA NOT NULL CHECK (octet_length(action_catalog_schema_hash)=32),
  action_catalog_epoch BIGINT NOT NULL,
  action_definition_hash BYTEA NOT NULL CHECK (octet_length(action_definition_hash)=32),
  state TEXT NOT NULL CHECK (state IN ('claimed','staged','completed','failed','canceled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_operations (
  operation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  kind TEXT NOT NULL CHECK (kind IN ('register','confirmation','refund','mirror')),
  logical_key BYTEA NOT NULL CHECK (octet_length(logical_key)=32),
  intent_hash BYTEA NOT NULL CHECK (octet_length(intent_hash)=32),
  canonical_intent JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending','broadcast','final','operator_attention','aborted_unattested',
    'aborted_unmirrored','blocked_parent_aborted'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at TIMESTAMPTZ,
  retry_once_used BOOLEAN NOT NULL DEFAULT false,
  last_error_class TEXT,
  result JSONB,
  final_block_number BIGINT,
  final_block_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(kind,logical_key)
);

CREATE TABLE standard_reputation_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL REFERENCES standard_reputation_operations(operation_id),
  chain_id BIGINT NOT NULL,
  relayer_address TEXT NOT NULL,
  nonce BIGINT NOT NULL CHECK (nonce >= 0),
  destination TEXT NOT NULL,
  value NUMERIC(78,0) NOT NULL CHECK (value = 0),
  intent_hash BYTEA NOT NULL CHECK (octet_length(intent_hash)=32),
  calldata_hash BYTEA NOT NULL CHECK (octet_length(calldata_hash)=32),
  encrypted_raw_transaction BYTEA NOT NULL,
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('prepared','broadcast','final','failed','operator_attention')),
  block_number BIGINT,
  block_hash TEXT,
  final_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id,relayer_address,nonce)
);

CREATE INDEX standard_reputation_transactions_state_idx
  ON standard_reputation_transactions(state,created_at)
  WHERE state IN ('prepared','broadcast');

CREATE INDEX standard_reputation_work_idx
  ON standard_reputation_operations(state,next_attempt_at,created_at)
  WHERE state IN ('pending','broadcast');

CREATE TABLE standard_confirmation_preparations (
  preparation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  order_key BYTEA NOT NULL CHECK (octet_length(order_key)=32),
  payer TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('attest-confirmation','revoke-confirmation')),
  confirmation TEXT CHECK (confirmation IN ('Confirmed','NotConfirmed')),
  current_uid BYTEA CHECK (current_uid IS NULL OR octet_length(current_uid)=32),
  transitions_used SMALLINT NOT NULL CHECK (transitions_used BETWEEN 0 AND 2),
  eas_nonce NUMERIC(78,0) NOT NULL CHECK (eas_nonce >= 0),
  deadline BIGINT NOT NULL,
  request_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(request_hash)=32),
  canonical_typed_data JSONB NOT NULL,
  final_transition_acknowledged BOOLEAN NOT NULL,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX standard_confirmation_preparation_active_nonce_idx
  ON standard_confirmation_preparations(payer,eas_nonce) WHERE consumed_at IS NULL;

CREATE TABLE standard_confirmation_sponsorships (
  sponsorship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  preparation_id UUID NOT NULL UNIQUE REFERENCES standard_confirmation_preparations(preparation_id),
  operation_id UUID NOT NULL UNIQUE REFERENCES standard_reputation_operations(operation_id),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  payer TEXT NOT NULL,
  utc_day DATE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','charged','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX standard_confirmation_sponsorship_payer_day_idx
  ON standard_confirmation_sponsorships(payer,utc_day) WHERE state<>'released';
CREATE INDEX standard_confirmation_sponsorship_global_day_idx
  ON standard_confirmation_sponsorships(utc_day) WHERE state<>'released';

CREATE TABLE standard_reputation_confirmations (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  order_key BYTEA NOT NULL UNIQUE CHECK (octet_length(order_key)=32),
  current_uid BYTEA CHECK (current_uid IS NULL OR octet_length(current_uid)=32),
  confirmation TEXT NOT NULL CHECK (confirmation IN ('Pending','Confirmed','NotConfirmed')),
  transitions_used SMALLINT NOT NULL CHECK (transitions_used BETWEEN 0 AND 3),
  finalized_block BIGINT NOT NULL,
  finalized_block_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_admin_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID REFERENCES standard_reputation_operations(operation_id),
  mirror_order_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('reconcile','retry-once','abort')),
  reason TEXT NOT NULL,
  previous_state TEXT NOT NULL,
  resulting_state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((operation_id IS NULL) <> (mirror_order_id IS NULL))
);

CREATE TABLE standard_reputation_mirrors (
  order_id TEXT PRIMARY KEY REFERENCES standard_orders(order_id),
  desired_revision BIGINT NOT NULL DEFAULT 0,
  desired_confirmation TEXT CHECK (desired_confirmation IN ('Confirmed','NotConfirmed')),
  desired_uid BYTEA CHECK (desired_uid IS NULL OR octet_length(desired_uid)=32),
  active_feedback_index BIGINT,
  active_uid BYTEA CHECK (active_uid IS NULL OR octet_length(active_uid)=32),
  state TEXT NOT NULL CHECK (state IN ('pending','broadcast','current','paused','operator_attention','aborted_unmirrored')),
  transaction_count SMALLINT NOT NULL DEFAULT 0,
  attempts SMALLINT NOT NULL DEFAULT 0,
  retry_once_used BOOLEAN NOT NULL DEFAULT false,
  next_attempt_at TIMESTAMPTZ,
  last_error_class TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_mirror_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES standard_reputation_mirrors(order_id),
  desired_revision BIGINT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('give','revoke')),
  target_uid BYTEA CHECK (
    (operation='give' AND target_uid IS NOT NULL AND octet_length(target_uid)=32)
    OR (operation='revoke' AND target_uid IS NULL)
  ),
  target_confirmation TEXT CHECK (
    (operation='give' AND target_confirmation IN ('Confirmed','NotConfirmed'))
    OR (operation='revoke' AND target_confirmation IS NULL)
  ),
  chain_id BIGINT NOT NULL,
  nonce BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  encrypted_raw_transaction BYTEA NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','broadcast','final','failed','operator_attention')),
  block_number BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chain_id,nonce)
);

CREATE TABLE standard_order_notification_subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL UNIQUE REFERENCES standard_orders(order_id),
  payer TEXT NOT NULL,
  callback_audience_hash BYTEA NOT NULL CHECK (octet_length(callback_audience_hash)=32),
  callback_display_origin TEXT NOT NULL,
  encrypted_callback_url BYTEA NOT NULL,
  subscriber_verification_address TEXT,
  challenge_hash BYTEA NOT NULL CHECK (octet_length(challenge_hash)=32),
  state TEXT NOT NULL CHECK (state IN ('pending','active','deleted')),
  challenge_expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_order_notification_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  transition_id BIGINT NOT NULL UNIQUE REFERENCES standard_order_transitions(transition_id),
  subscription_id UUID NOT NULL REFERENCES standard_order_notification_subscriptions(subscription_id),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  canonical_event JSONB NOT NULL,
  signed_envelope JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','delivering','delivered','operator_attention','deleted')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id,sequence)
);
CREATE INDEX standard_order_notification_work_idx
  ON standard_order_notification_events(state,next_attempt_at)
  WHERE state IN ('pending','delivering');

CREATE TABLE standard_reputation_projection_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  chain_id BIGINT NOT NULL,
  contract_address TEXT NOT NULL,
  deployment_block BIGINT NOT NULL CHECK (deployment_block > 0),
  last_indexed_block BIGINT NOT NULL,
  last_indexed_block_hash TEXT,
  last_success_at TIMESTAMPTZ,
  terminal_error_class TEXT,
  terminal_error_at TIMESTAMPTZ,
  recovery_scan_index BIGINT NOT NULL DEFAULT 0 CHECK (recovery_scan_index >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_projection_blocks (
  block_number BIGINT PRIMARY KEY,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE standard_reputation_projection_events (
  transaction_hash TEXT NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  block_number BIGINT NOT NULL,
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  order_key BYTEA NOT NULL CHECK (octet_length(order_key)=32),
  event_name TEXT NOT NULL CHECK (event_name IN (
    'StandardOrderRegistered','OutcomeRecorded','BuyerConfirmationSubmitted',
    'BuyerConfirmationRevoked','ReputationRefunded'
  )),
  PRIMARY KEY (transaction_hash,log_index)
);
CREATE INDEX standard_reputation_projection_events_block_idx
  ON standard_reputation_projection_events(block_number);

CREATE TABLE standard_reputation_projection_records (
  order_key BYTEA PRIMARY KEY CHECK (octet_length(order_key)=32),
  authorization_key BYTEA NOT NULL CHECK (octet_length(authorization_key)=32),
  provider_agent_id NUMERIC(78,0) NOT NULL CHECK (provider_agent_id > 0),
  service_id BYTEA NOT NULL CHECK (octet_length(service_id)=32),
  payer TEXT NOT NULL,
  gross_amount NUMERIC(78,0) NOT NULL CHECK (gross_amount > 0),
  paid_at BIGINT NOT NULL CHECK (paid_at > 0),
  outcome SMALLINT CHECK (outcome BETWEEN 0 AND 2),
  confirmation SMALLINT NOT NULL CHECK (confirmation BETWEEN 0 AND 2),
  outcome_attestation_delay BIGINT,
  outcome_timestamp BIGINT NOT NULL,
  confirmation_timestamp BIGINT NOT NULL,
  confirmation_transitions SMALLINT NOT NULL CHECK (confirmation_transitions BETWEEN 0 AND 3),
  outcome_recorded BOOLEAN NOT NULL,
  reputation_eligible BOOLEAN NOT NULL,
  current_confirmation_uid BYTEA NOT NULL CHECK (octet_length(current_confirmation_uid)=32),
  cumulative_refunded NUMERIC(78,0) NOT NULL CHECK (cumulative_refunded >= 0),
  last_event_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX standard_reputation_projection_provider_idx
  ON standard_reputation_projection_records(provider_agent_id) WHERE reputation_eligible;
CREATE INDEX standard_reputation_projection_service_idx
  ON standard_reputation_projection_records(service_id) WHERE reputation_eligible;
CREATE INDEX standard_reputation_projection_payer_idx
  ON standard_reputation_projection_records(lower(payer)) WHERE reputation_eligible;
