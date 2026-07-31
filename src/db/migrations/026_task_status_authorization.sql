DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM task_mappings
     WHERE buyer_token_id IS NULL
       AND service_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'buyer-bound task mappings require explicit buyer reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM task_mappings
     WHERE task_id IS NOT NULL
     GROUP BY provider_a2a_url, task_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate provider task mappings require explicit reconciliation';
  END IF;
END
$$;

UPDATE task_mappings
   SET buyer_token_id = 0
 WHERE buyer_token_id IS NULL
   AND service_ref IS NULL;

ALTER TABLE task_mappings
  ALTER COLUMN buyer_token_id SET NOT NULL,
  ADD CONSTRAINT task_mappings_buyer_token_id_check
    CHECK (buyer_token_id >= 0);

DROP INDEX task_mappings_task_idx;

CREATE UNIQUE INDEX task_mappings_provider_task_idx
  ON task_mappings (provider_a2a_url, task_id)
  WHERE task_id IS NOT NULL;
