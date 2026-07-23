-- Versions 0.8.0 through 0.9.0 signed an empty contract-creation
-- transaction instead of a ReputationRegistry giveFeedback call. Requeue
-- only jobs whose mined receipt exposed that exact failure, and discard the
-- malformed raw transaction so the worker prepares corrected calldata.
UPDATE reputation_mirrors
   SET status = 'queued',
       prepared_tx = NULL,
       tx_nonce = NULL,
       tx_hash = NULL,
       attempts = 0,
       next_attempt_at = now(),
       last_error = NULL,
       updated_at = now()
 WHERE status IN ('retry', 'failed')
   AND last_error LIKE 'NewFeedback event missing from transaction 0x%';
