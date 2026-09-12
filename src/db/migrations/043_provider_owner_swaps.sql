-- Provider-signed owner swaps (ProviderOwnerSwapV1). A swap adds gateway
-- eligibility for (new_payer, provider_agent_id) anchored to one of the
-- signing provider's orders; it rewrites no order, receipt, claim, nonce, or
-- reputation row. Idempotent by (provider, asset, version) and content hash.
CREATE TABLE standard_provider_owner_swaps (
  provider_agent_id TEXT NOT NULL CHECK (provider_agent_id ~ '^(0|[1-9][0-9]{0,77})$'),
  provider_asset_id UUID NOT NULL,
  owner_version INTEGER NOT NULL CHECK (owner_version >= 1),
  order_id TEXT NOT NULL REFERENCES standard_orders(order_id),
  previous_payer TEXT NOT NULL CHECK (previous_payer ~ '^0x[0-9a-f]{40}$'),
  new_payer TEXT NOT NULL CHECK (new_payer ~ '^0x[0-9a-f]{40}$'),
  content_hash BYTEA NOT NULL CHECK (octet_length(content_hash) = 32),
  canonical_envelope JSONB NOT NULL,
  signer TEXT NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_agent_id, provider_asset_id, owner_version),
  CHECK (new_payer <> previous_payer)
);

CREATE INDEX standard_provider_owner_swaps_payer_idx
  ON standard_provider_owner_swaps(new_payer, provider_agent_id);

CREATE INDEX standard_provider_owner_swaps_received_idx
  ON standard_provider_owner_swaps(provider_agent_id, received_at);
