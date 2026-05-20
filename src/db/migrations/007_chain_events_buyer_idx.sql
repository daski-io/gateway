-- Per-buyer reads. /public/v1/buyers/:agentId aggregates over a single
-- buyer_agent_id and lists the buyer's most-recent settled rows; both
-- queries scan with `WHERE buyer_agent_id = $1 ORDER BY settled_at
-- DESC`, identical access pattern to the existing
-- chain_events_service_id_settled_at_idx for the service-scoped case.
-- Without this, the aggregate falls back to a sequential scan once the
-- table grows past a few thousand rows.
CREATE INDEX chain_events_buyer_agent_id_settled_at_idx
  ON chain_events (buyer_agent_id, settled_at DESC);
