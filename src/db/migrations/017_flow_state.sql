-- Durable flow state (Tier 2 of the 260725 agent-UX plan).
--
-- payment_challenges gains the quoted request's canonical serviceArgs and
-- the acknowledgements captured at quote time: continuation calls (settle
-- retry, task submit) can then omit full re-entry — the gateway restores
-- the exact bytes the quote committed to — and acknowledgements survive
-- restarts and replicas instead of living in a per-process HMAC secret.
--
-- task_mappings persists the operation <-> A2A contextId/taskId mapping.
-- A row is written BEFORE the provider dispatch and completed after the
-- response, so a response lost to a timeout leaves a recoverable trace
-- (the 2026-07-24 register-domain timeouts lost the taskId with the
-- response and false-failed the run).

ALTER TABLE payment_challenges
  ADD COLUMN IF NOT EXISTS service_args JSONB,
  ADD COLUMN IF NOT EXISTS acknowledgements JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS task_mappings (
  id BIGSERIAL PRIMARY KEY,
  context_id TEXT NOT NULL,
  message_id TEXT,
  task_id TEXT,
  service_ref BYTEA,
  provider_a2a_url TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  buyer_token_id NUMERIC,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_mappings_context_idx
  ON task_mappings (context_id);
CREATE INDEX IF NOT EXISTS task_mappings_task_idx
  ON task_mappings (task_id);
CREATE INDEX IF NOT EXISTS task_mappings_service_ref_idx
  ON task_mappings (service_ref);
