-- Chain-events mirror (2026-05). Until now /public/v1/activity has read
-- exclusively from `payment_challenges` — rows this gateway issued and
-- saw settle. That misses every settlement that came through a different
-- gateway or directly via PaymentRouter, which is why
-- `/activity` was perpetually behind `getServiceStats.completed`.
--
-- This table is the gateway's local mirror of on-chain `PaymentSettled`
-- events, enriched on read with `ReputationStorage.getRecord` and
-- `PaymentRouter.refundedAmount`. It's the read-side source for
-- /activity and the per-service recentPurchases list. Off-chain
-- enrichment (skill_id, original a2a_url, walletAddress) still lives in
-- payment_challenges; consumers LEFT JOIN by paymentId. Rows that came
-- through this gateway get rich enrichment; rows that didn't render
-- with thinner metadata (skill_id null, dash in the UI).
--
-- Indexer cadence: 5s poll of PaymentSettled via eth_getLogs, plus
-- periodic refresh of recent rows for outcome/confirmation/refund
-- updates. `last_refreshed_at` lets the worker re-check rows that
-- might still receive attestations.
CREATE TABLE chain_events (
  payment_id           BIGINT PRIMARY KEY,
  tx_hash              BYTEA NOT NULL,
  block_number         BIGINT NOT NULL,
  service_id           BYTEA NOT NULL,
  buyer_agent_id       BIGINT NOT NULL,
  provider_agent_id    BIGINT NOT NULL,
  amount_atomic        NUMERIC(78) NOT NULL,
  settled_at           TIMESTAMPTZ NOT NULL,
  -- Provider-attested outcome (0=Completed, 1=Failed, 2=Canceled). NULL
  -- while pending — present once the provider files the outcome
  -- attestation.
  outcome              SMALLINT,
  -- Buyer's confirmation (0=Pending, 1=Confirmed, 2=NotConfirmed).
  -- Defaults to 0 since the resolver doesn't pre-populate the record.
  confirmation         SMALLINT NOT NULL DEFAULT 0,
  fulfillment_seconds  INTEGER,
  refunded_atomic      NUMERIC(78) NOT NULL DEFAULT 0,
  confirmation_uid     BYTEA,
  outcome_uid          BYTEA,
  -- Last time the indexer refreshed this row's outcome / confirmation
  -- / refund state. Used by the worker to bound re-poll cost: rows
  -- whose state is "stable" (refunded > 0, confirmation != Pending)
  -- can be refreshed less often than rows still expecting an attest.
  last_refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- /activity orders by settled_at desc with no filter. Per-service
-- queries filter by service_id then order by settled_at. Both are
-- supported by a (settled_at desc) index for the global case and
-- (service_id, settled_at desc) for the per-service case.
CREATE INDEX chain_events_settled_at_idx
  ON chain_events (settled_at DESC);

CREATE INDEX chain_events_service_id_settled_at_idx
  ON chain_events (service_id, settled_at DESC);

-- For the worker's "refresh stale rows" sweep: cheap lookup of rows
-- whose state is still mutable (no refund, no terminal confirmation)
-- and that haven't been refreshed recently. Partial index keeps the
-- footprint small once most rows are terminal.
CREATE INDEX chain_events_pending_idx
  ON chain_events (last_refreshed_at)
  WHERE confirmation = 0 OR refunded_atomic = 0;

-- Single-row cursor for the indexer's `last indexed block`. Survives
-- restarts; the worker resumes from the next block on startup.
-- `id` is a constant 1 so the cursor row is unique by construction.
CREATE TABLE chain_indexer_state (
  id                 SMALLINT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL DEFAULT 0,
  last_indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chain_indexer_state_singleton CHECK (id = 1)
);
INSERT INTO chain_indexer_state (id, last_indexed_block) VALUES (1, 0)
  ON CONFLICT (id) DO NOTHING;
