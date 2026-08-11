ALTER TABLE bazaar_listing_bindings
  ADD COLUMN fulfillment_signer BYTEA NOT NULL
    CHECK (
      octet_length(fulfillment_signer) = 20 AND
      fulfillment_signer <> decode(repeat('00', 20), 'hex')
    ),
  ADD CONSTRAINT bazaar_listing_bindings_fulfillment_role_check CHECK (
    fulfillment_signer <> pay_to
  );

CREATE TABLE bazaar_key_roles (
  key_address BYTEA PRIMARY KEY CHECK (
    octet_length(key_address) = 20 AND
    key_address <> decode(repeat('00', 20), 'hex')
  ),
  key_role TEXT NOT NULL CHECK (key_role IN (
    'provider', 'fulfillment', 'daski_lifecycle', 'daski_refund'
  )),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bazaar_orders
  ADD COLUMN fulfillment_signer BYTEA NOT NULL
    CHECK (
      octet_length(fulfillment_signer) = 20 AND
      fulfillment_signer <> decode(repeat('00', 20), 'hex')
    ),
  ADD CONSTRAINT bazaar_orders_fulfillment_role_check CHECK (
    fulfillment_signer <> payer AND fulfillment_signer <> token
      AND fulfillment_signer <> pay_to
  );

ALTER TABLE bazaar_orders DROP CONSTRAINT bazaar_orders_state_check;
ALTER TABLE bazaar_orders ADD CONSTRAINT bazaar_orders_state_check CHECK (
  state IN (
    'attempt_opened', 'verify_rejected', 'verify_ambiguous', 'settle_started',
    'settle_rejected', 'settle_ambiguous', 'settle_confirmed',
    'evidence_rejected', 'settled', 'dispatch_started', 'dispatch_ambiguous',
    'dispatch_failed', 'dispatched', 'fulfilled', 'fulfillment_refund_due',
    'rejected_expired_no_transfer', 'ambiguous_expired_no_transfer',
    'invalid_evidence_expired_no_transfer', 'unapproved_direct_inbound',
    'settlement_refund_due', 'refund_finalized', 'refund_blocked_issuer'
  )
);

ALTER TABLE bazaar_orders ADD CONSTRAINT
  bazaar_orders_fulfillment_task_check CHECK (
    state NOT IN ('fulfilled', 'fulfillment_refund_due')
      OR (task_id IS NOT NULL AND task_id_hash IS NOT NULL)
  );

ALTER TABLE bazaar_orders ADD CONSTRAINT
  bazaar_orders_fulfillment_settlement_check CHECK (
    state NOT IN ('fulfilled', 'fulfillment_refund_due')
      OR settlement_transaction IS NOT NULL
  );

CREATE TABLE bazaar_fulfillment_attestations (
  order_record_id BYTEA PRIMARY KEY REFERENCES bazaar_orders(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  evidence_id BYTEA NOT NULL UNIQUE CHECK (
    octet_length(evidence_id) = 32 AND
    evidence_id <> decode(repeat('00', 32), 'hex')
  ),
  attestation_digest BYTEA NOT NULL UNIQUE
    CHECK (
      octet_length(attestation_digest) = 32 AND
      attestation_digest <> decode(repeat('00', 32), 'hex')
    ),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'FULFILLED', 'PROVIDER_COMPLIANCE_FAILURE',
    'PROVIDER_FULFILLMENT_FAILURE'
  )),
  evidence_hash BYTEA NOT NULL CHECK (
    octet_length(evidence_hash) = 32 AND
    evidence_hash <> decode(repeat('00', 32), 'hex')
  ),
  signature BYTEA NOT NULL CHECK (octet_length(signature) = 65),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bazaar_fulfillment_jobs (
  order_record_id BYTEA PRIMARY KEY REFERENCES bazaar_orders(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'working', 'complete'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128
  ),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state = 'working' AND lease_token IS NOT NULL AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (state <> 'working' AND lease_token IS NULL AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  )
);

CREATE INDEX bazaar_fulfillment_jobs_due_idx
  ON bazaar_fulfillment_jobs (state, next_attempt_at)
  WHERE state IN ('pending', 'working');
