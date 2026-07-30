-- Bind every new x402 challenge to the service payee observed at issuance.
-- Existing challenges remain readable but cannot settle without this binding.

ALTER TABLE payment_challenges
  ADD COLUMN expected_payee TEXT,
  ADD COLUMN expected_payee_block NUMERIC(78, 0);
