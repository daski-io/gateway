-- Durable evidence for sanctions-screening failures. Reverted transactions
-- have no contract log, so this table is independent of chain_events and
-- copies the challenge context needed after ordinary challenge cleanup.

ALTER TABLE payment_challenges
  DROP CONSTRAINT payment_challenges_settlement_state_check;

ALTER TABLE payment_challenges
  ADD CONSTRAINT payment_challenges_settlement_state_check
  CHECK (
    settlement_state IN (
      'pending',
      'settlement_broadcast',
      'paid',
      'expired',
      'sanctions_rejected'
    )
  );

CREATE TABLE settlement_screening_events (
  event_id              BIGSERIAL PRIMARY KEY,
  service_ref           BYTEA NOT NULL,
  provider_token_id     BIGINT NOT NULL,
  buyer_token_id        BIGINT NOT NULL,
  service_id            BYTEA NOT NULL,
  payer_wallet          TEXT NOT NULL,
  chain_id              BIGINT NOT NULL,
  payment_router        TEXT NOT NULL,
  adapter_address       TEXT NOT NULL,
  operation             TEXT NOT NULL
                        CHECK (operation IN ('settle', 'settle_with_registration')),
  code                  TEXT NOT NULL
                        CHECK (code IN (
                          'SANCTIONS_ADDRESS_REJECTED',
                          'SANCTIONS_SCREENING_UNAVAILABLE'
                        )),
  retryable             BOOLEAN NOT NULL,
  selector              BYTEA NOT NULL CHECK (octet_length(selector) = 4),
  argument_kind         TEXT NOT NULL CHECK (argument_kind IN ('account', 'oracle')),
  decoded_address       TEXT NOT NULL,
  detection_source      TEXT NOT NULL
                        CHECK (detection_source IN (
                          'simulation', 'submission', 'receipt_replay'
                        )),
  transaction_hash      TEXT,
  retention_class       TEXT NOT NULL
                        CHECK (retention_class IN (
                          'compliance_evidence', 'operational_telemetry'
                        )),
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count      INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0)
);

CREATE UNIQUE INDEX idx_settlement_screening_event_identity
  ON settlement_screening_events (
    service_ref,
    code,
    selector,
    decoded_address,
    detection_source,
    COALESCE(transaction_hash, '')
  );

CREATE INDEX idx_settlement_screening_events_created
  ON settlement_screening_events(last_seen_at DESC);
