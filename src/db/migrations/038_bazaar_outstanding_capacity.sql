CREATE INDEX bazaar_exposures_open_order_idx
  ON bazaar_exposures (order_record_id)
  WHERE state <> 'released';

CREATE INDEX bazaar_exposures_open_provider_idx
  ON bazaar_exposures (provider_agent_id, order_record_id)
  WHERE state <> 'released';

CREATE INDEX bazaar_exposures_open_payer_idx
  ON bazaar_exposures (payer, order_record_id)
  WHERE state <> 'released';

CREATE INDEX bazaar_orders_provider_created_at_idx
  ON bazaar_orders (provider_agent_id, created_at);
