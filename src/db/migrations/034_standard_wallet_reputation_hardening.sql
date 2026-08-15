ALTER TABLE standard_asset_action_claims
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN confirmation_hash BYTEA CHECK (
    confirmation_hash IS NULL OR octet_length(confirmation_hash)=32
  ),
  ADD COLUMN earliest_execution_at TIMESTAMPTZ;

ALTER TABLE standard_reputation_operations
  ADD COLUMN intent_predecessors JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE standard_reputation_transactions
  DROP CONSTRAINT standard_reputation_transactions_chain_id_relayer_address_nonce_key;

CREATE UNIQUE INDEX standard_reputation_transactions_active_nonce_idx
  ON standard_reputation_transactions(chain_id,relayer_address,nonce)
  WHERE state IN ('prepared','broadcast','operator_attention');

ALTER TABLE standard_reputation_mirror_transactions
  DROP CONSTRAINT standard_reputation_mirror_transactions_chain_id_nonce_key;

CREATE UNIQUE INDEX standard_reputation_mirror_transactions_active_nonce_idx
  ON standard_reputation_mirror_transactions(chain_id,nonce)
  WHERE state IN ('prepared','broadcast','operator_attention');
