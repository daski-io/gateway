-- 007: multi-service providers. Skill ids are only unique WITHIN a
-- service (a provider's domain card and mailbox card both legitimately
-- offer `check-availability`), so the embedding identity gains the
-- service slug. Existing rows get '' and are rewritten/pruned by the
-- next syncSkillEmbeddings pass (single-card providers without a
-- declared slug keep '' as their steady state).

ALTER TABLE skill_embeddings ADD COLUMN service_slug TEXT NOT NULL DEFAULT '';
ALTER TABLE skill_embeddings DROP CONSTRAINT skill_embeddings_pkey;
ALTER TABLE skill_embeddings ADD PRIMARY KEY (provider_agent_id, service_slug, skill_id);
