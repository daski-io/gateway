CREATE TABLE bazaar_lifecycle_domains (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  pay_to BYTEA NOT NULL CHECK (octet_length(pay_to) = 20),
  offer_signer BYTEA NOT NULL CHECK (octet_length(offer_signer) = 20),
  listing_epoch BYTEA NOT NULL UNIQUE CHECK (octet_length(listing_epoch) = 32),
  listing_commitment BYTEA NOT NULL UNIQUE
    REFERENCES bazaar_listing_bindings(listing_commitment)
    CHECK (octet_length(listing_commitment) = 32),
  provider_agent_id NUMERIC(78, 0) NOT NULL CHECK (provider_agent_id > 0),
  outcome_id BYTEA NOT NULL CHECK (octet_length(outcome_id) = 32),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  retired_at TIMESTAMPTZ,
  accept_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, pay_to),
  CHECK (
    (active AND retired_at IS NULL AND accept_until IS NULL)
    OR
    (NOT active AND retired_at IS NOT NULL AND accept_until > retired_at)
  )
);

CREATE INDEX bazaar_lifecycle_domains_retention_idx
  ON bazaar_lifecycle_domains (accept_until)
  WHERE NOT active;
