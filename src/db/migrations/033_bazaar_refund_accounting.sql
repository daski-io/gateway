ALTER TABLE bazaar_orders DROP CONSTRAINT bazaar_orders_state_check;
ALTER TABLE bazaar_orders ADD CONSTRAINT bazaar_orders_state_check CHECK (
  state IN (
    'attempt_opened', 'verify_rejected', 'verify_ambiguous', 'settle_started',
    'settle_rejected', 'settle_ambiguous', 'settle_confirmed',
    'evidence_rejected', 'settled', 'dispatch_started', 'dispatch_ambiguous',
    'dispatch_failed', 'dispatched'
  )
);
ALTER TABLE bazaar_orders ADD CONSTRAINT
  bazaar_orders_dispatch_ambiguous_transaction_check CHECK (
    state <> 'dispatch_ambiguous' OR settlement_transaction IS NOT NULL
  );

CREATE TABLE bazaar_exposures (
  order_record_id BYTEA PRIMARY KEY REFERENCES bazaar_orders(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  authorization_digest BYTEA NOT NULL UNIQUE
    CHECK (octet_length(authorization_digest) = 32),
  provider_agent_id NUMERIC(78, 0) NOT NULL CHECK (provider_agent_id > 0),
  payer BYTEA NOT NULL CHECK (octet_length(payer) = 20),
  token BYTEA NOT NULL CHECK (octet_length(token) = 20),
  gross_amount NUMERIC(78, 0) NOT NULL CHECK (gross_amount > 0),
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'paid_unfulfilled', 'refund_due', 'released'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bazaar_exposures_provider_state_idx
  ON bazaar_exposures (provider_agent_id, state);

CREATE TABLE bazaar_refund_obligations (
  order_record_id BYTEA PRIMARY KEY REFERENCES bazaar_orders(order_record_id)
    CHECK (octet_length(order_record_id) = 32),
  refund_id BYTEA NOT NULL UNIQUE CHECK (octet_length(refund_id) = 32),
  authorization_digest BYTEA NOT NULL UNIQUE
    CHECK (octet_length(authorization_digest) = 32),
  provider_agent_id NUMERIC(78, 0) NOT NULL CHECK (provider_agent_id > 0),
  payer BYTEA NOT NULL CHECK (octet_length(payer) = 20),
  token BYTEA NOT NULL CHECK (octet_length(token) = 20),
  gross_amount NUMERIC(78, 0) NOT NULL CHECK (gross_amount > 0),
  primary_reason TEXT NOT NULL CHECK (primary_reason IN (
    'AMBIGUOUS_PAID', 'SETTLEMENT_EVIDENCE_INVALID',
    'SPLIT_OR_TOKEN_FAILURE', 'PROVIDER_COMPLIANCE_FAILURE',
    'PROVIDER_FULFILLMENT_FAILURE', 'DISPUTE_APPROVED'
  )),
  state TEXT NOT NULL DEFAULT 'due' CHECK (state IN (
    'due', 'broadcast', 'finalized', 'blocked_issuer'
  )),
  due_at TIMESTAMPTZ NOT NULL,
  refund_transaction BYTEA UNIQUE CHECK (
    refund_transaction IS NULL OR octet_length(refund_transaction) = 32
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (state IN ('due', 'blocked_issuer') AND refund_transaction IS NULL)
    OR (state IN ('broadcast', 'finalized') AND refund_transaction IS NOT NULL)
  )
);

CREATE INDEX bazaar_refund_obligations_provider_state_due_idx
  ON bazaar_refund_obligations (provider_agent_id, state, due_at);

CREATE TABLE bazaar_refund_reason_events (
  order_record_id BYTEA NOT NULL
    REFERENCES bazaar_refund_obligations(order_record_id),
  reason TEXT NOT NULL CHECK (reason IN (
    'AMBIGUOUS_PAID', 'SETTLEMENT_EVIDENCE_INVALID',
    'SPLIT_OR_TOKEN_FAILURE', 'PROVIDER_COMPLIANCE_FAILURE',
    'PROVIDER_FULFILLMENT_FAILURE', 'DISPUTE_APPROVED'
  )),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_record_id, reason)
);
