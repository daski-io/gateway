CREATE UNIQUE INDEX bazaar_orders_provider_task_unique
  ON bazaar_orders (provider_agent_id, task_id_hash)
  WHERE task_id_hash IS NOT NULL;
