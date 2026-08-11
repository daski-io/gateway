ALTER TABLE bazaar_exposures
  ADD COLUMN refund_wallet BYTEA NOT NULL
    CHECK (octet_length(refund_wallet) = 20),
  ADD COLUMN refund_policy_version BYTEA NOT NULL
    CHECK (octet_length(refund_policy_version) = 32),
  ADD COLUMN refund_sla_seconds INTEGER NOT NULL
    CHECK (refund_sla_seconds BETWEEN 60 AND 2592000),
  ADD CONSTRAINT bazaar_exposures_refund_role_check CHECK (
    refund_wallet <> payer AND refund_wallet <> token
  );

ALTER TABLE bazaar_refund_obligations
  ADD COLUMN refund_wallet BYTEA NOT NULL
    CHECK (octet_length(refund_wallet) = 20),
  ADD COLUMN refund_policy_version BYTEA NOT NULL
    CHECK (octet_length(refund_policy_version) = 32),
  ADD CONSTRAINT bazaar_refund_obligations_refund_role_check CHECK (
    refund_wallet <> payer AND refund_wallet <> token
  );
