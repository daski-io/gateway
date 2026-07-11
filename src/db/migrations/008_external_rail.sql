-- External-facilitator rail (x402 Bazaar listability). Challenges created
-- by the Bazaar-facing resource route are settled on-chain by an EXTERNAL
-- x402 facilitator (CDP) as a bare EIP-3009 transfer into the router, then
-- attributed (split + payment record) via DirectTransferAdapter in a
-- follow-up gateway transaction. Three columns track that lifecycle:
--
--   rail               'daski'    — gateway-submitted X402Adapter settle
--                      'external' — CDP-settled + gateway-attributed
--   auth_nonce         client-chosen EIP-3009 nonce (0x… 32-byte hex).
--                      On the external rail clients pick random nonces, so
--                      (wallet_address, auth_nonce) is the only stable key
--                      a paid retry of the same payload can be resolved by.
--   external_settle_tx tx hash of the external facilitator's settle.
--                      Written BEFORE the attribution tx is submitted so a
--                      gateway crash between the two is recoverable: the
--                      retry sees the hash, skips re-settling, and goes
--                      straight to attribution.

ALTER TABLE payment_challenges ADD COLUMN rail TEXT NOT NULL DEFAULT 'daski';
ALTER TABLE payment_challenges
  ADD CONSTRAINT payment_challenges_rail_check CHECK (rail IN ('daski', 'external'));
ALTER TABLE payment_challenges ADD COLUMN auth_nonce TEXT;
ALTER TABLE payment_challenges ADD COLUMN external_settle_tx TEXT;

-- Idempotency + double-processing guard: at most one challenge per
-- (wallet, auth nonce). The EIP-3009 nonce is single-use on-chain per
-- authorizer, so this mirrors the token's own replay protection.
CREATE UNIQUE INDEX idx_challenges_wallet_auth_nonce
  ON payment_challenges(wallet_address, auth_nonce)
  WHERE auth_nonce IS NOT NULL;
