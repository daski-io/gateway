-- Provider quote-commitment integration (provider audit item 1.1).
--
-- The provider signs every paid quote (POST /quote/:slug → quote{...}) and
-- enforces at task-submit time that the settled serviceRef equals
-- keccak256(canonicalJson(signedQuotePayload)) and that A2A metadata
-- carries the matching quoteId + quoteSignature — otherwise the task is
-- rejected AFTER funds were captured (-32111 quote_missing).
--
-- The gateway therefore adopts quote.serviceRef as the challenge
-- serviceRef and persists the two credentials it must forward at
-- daski_submit_task time, the signed requestHash needed to bind retries
-- to the quoted serviceArgs, plus the quote expiry that bounds the
-- challenge's own validity (an authorization settled after quote expiry
-- would strand captured funds provider-side).
--
-- Nullable so the migration can preserve historical challenge rows. All new
-- paid challenges require these fields at the application boundary.

ALTER TABLE payment_challenges ADD COLUMN quote_id TEXT;
ALTER TABLE payment_challenges ADD COLUMN quote_signature TEXT;
ALTER TABLE payment_challenges ADD COLUMN quote_expires_at TIMESTAMPTZ;
ALTER TABLE payment_challenges ADD COLUMN quote_request_hash BYTEA;
