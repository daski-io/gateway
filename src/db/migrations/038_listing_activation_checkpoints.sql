-- Chain facts captured at each paid splitter's verified deployment block.
-- Written once at evidence verification; settlement evidence relies on the
-- exact recorded values, and reused listings keep their original checkpoint.
ALTER TABLE standard_service_listings
  ADD COLUMN activation_checkpoint JSONB;
