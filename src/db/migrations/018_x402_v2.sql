-- Persist the canonical x402 V2 wire objects and replay bindings.
-- Pre-V2 pending challenges cannot be paid through the V2-only gateway.

ALTER TABLE payment_challenges
  ADD COLUMN IF NOT EXISTS x402_version SMALLINT,
  ADD COLUMN IF NOT EXISTS payment_required JSONB,
  ADD COLUMN IF NOT EXISTS requirements_hash BYTEA,
  ADD COLUMN IF NOT EXISTS resource_url TEXT,
  ADD COLUMN IF NOT EXISTS daski_extension JSONB,
  ADD COLUMN IF NOT EXISTS request_fingerprint BYTEA,
  ADD COLUMN IF NOT EXISTS registration_delegation JSONB,
  ADD COLUMN IF NOT EXISTS accepted_payer TEXT,
  ADD COLUMN IF NOT EXISTS eip3009_nonce BYTEA,
  ADD COLUMN IF NOT EXISTS payment_payload_fingerprint BYTEA,
  ADD COLUMN IF NOT EXISTS settle_response JSONB;

UPDATE payment_challenges
   SET x402_version = 1,
       settlement_state = CASE
         WHEN settlement_state = 'pending' THEN 'expired'
         ELSE settlement_state
       END
 WHERE x402_version IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_challenges_payer_nonce_idx
  ON payment_challenges (accepted_payer, eip3009_nonce)
  WHERE accepted_payer IS NOT NULL AND eip3009_nonce IS NOT NULL;
