-- Retirement fences new executions. Generic post-completion reviews, support
-- accounting and reputation reconciliation remain valid buyer rights and do
-- not require the retired provider fulfillment handler.
CREATE OR REPLACE FUNCTION standard_order_journal_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_order standard_orders%ROWTYPE; bound_order_id TEXT;
BEGIN
  IF TG_TABLE_NAME='standard_reputation_transactions' THEN
    SELECT order_id INTO bound_order_id FROM standard_reputation_operations WHERE operation_id=NEW.operation_id;
  ELSE bound_order_id := NEW.order_id; END IF;
  IF bound_order_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT bound_order FROM standard_orders WHERE order_id=bound_order_id;
  IF bound_order.state='FULFILLED' AND TG_TABLE_NAME IN (
    'standard_reputation_operations','standard_reputation_transactions',
    'standard_confirmation_preparations','standard_confirmation_preparations_v2',
    'standard_confirmation_sponsorships','standard_confirmation_sponsorships_v2',
    'standard_security_incidents'
  ) THEN RETURN NEW; END IF;
  IF standard_contract_retired(bound_order.provider_agent_id,'listing',bound_order.listing_manifest_hash)
    THEN RAISE EXCEPTION 'CONTRACT_RETIRED'; END IF;
  RETURN NEW;
END $$;
