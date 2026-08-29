import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations } from "../src/db/pool.js";
import { StandardRailStore } from "../src/standardRail/store.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

// The live race of 2026-08-22, replayed against the real statements: a
// purchase request parked in DEPOSIT_FINAL for longer than the recovery due
// time (a release finality wait) while still driving the order.
describe("in-flight purchase lease (postgres)", () => {
  it("keeps recovery off an attended order and fences a stale driver out", async () => {
    const schema = `standard_lease_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 2 });
    const store = new StandardRailStore(pool);
    const orderId = "order-1";
    const leaseState = async () => {
      const row = await pool.query<{ lease_owner: string | null; live: boolean; lease_fence: string; state: string }>(
        `SELECT lease_owner, lease_until IS NOT NULL AND lease_until > now() AS live, lease_fence::text, state
         FROM standard_orders WHERE order_id=$1`,
        [orderId],
      );
      return row.rows[0]!;
    };
    const ageLastTransition = () => pool.query(
      "UPDATE standard_orders SET updated_at=now() - interval '60 seconds' WHERE order_id=$1",
      [orderId],
    );
    try {
      await runMigrations(pool);
      await pool.query(
        `INSERT INTO standard_orders (
           order_id, order_key, order_handle, handle_hash, state, provider_agent_id, outcome_id,
           binding_profile, listing_manifest_hash, provider_offer_hash, canonical_listing, quote_hash,
           canonical_quote, canonical_request_hash, canonical_request, order_nonce, gross_amount,
           rail_epoch, listing_epoch, version, lease_fence, expires_at, updated_at)
         VALUES ($1,$2,'handle-1',$3,'DEPOSIT_FINAL','7','outcome','recipe-bound-v1',$4,$5,'{}',$6,'{}',$7,'{}',$8,
           1000000, 1, 1, 7, 2, now() + interval '1 hour', now() - interval '60 seconds')`,
        [
          orderId, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4),
          Buffer.alloc(32, 5), Buffer.alloc(32, 6), Buffer.alloc(32, 7),
        ],
      );

      // The failure as it happened: a driver holding no lease is fenced out
      // the moment recovery leases the order it is still advancing.
      const unleasedDriver = await store.findById(orderId);
      expect(unleasedDriver).toMatchObject({ state: "DEPOSIT_FINAL", version: 7, leaseFence: 2 });
      const takenOver = await store.leaseRecoverable("standard-recovery-worker", 45);
      expect(takenOver).toMatchObject({ orderId, leaseFence: 3 });
      await expect(store.transition(unleasedDriver!, "RELEASE_FINAL", "release_evidence_final"))
        .rejects.toThrow("ORDER_TRANSITION_CONFLICT");
      await store.releaseLease(orderId, "standard-recovery-worker", 3);
      expect(await leaseState()).toMatchObject({ lease_owner: null, live: false, state: "DEPOSIT_FINAL" });

      // With the fix the request leases the order it drives: recovery sees an
      // attended order and leaves it alone, however old its last transition.
      const driver = `standard-request-${randomUUID()}`;
      const leased = await store.leaseOrder(orderId, driver, 45);
      expect(leased).toMatchObject({ orderId, state: "DEPOSIT_FINAL", leaseFence: 4 });
      await expect(store.leaseRecoverable("standard-recovery-worker", 45)).resolves.toBeNull();
      await expect(store.leaseOrder(orderId, "standard-request-other", 45)).resolves.toBeNull();

      // The driver's transitions succeed and keep its lease alive.
      const released = await store.transition(leased!, "RELEASE_FINAL", "release_evidence_final", {
        releaseTxHash: `0x${"ab".repeat(32)}`,
      });
      expect(released).toMatchObject({ state: "RELEASE_FINAL", version: 8, leaseFence: 4 });
      expect(await leaseState()).toMatchObject({ lease_owner: driver, live: true, lease_fence: "4" });
      await ageLastTransition();
      await expect(store.leaseRecoverable("standard-recovery-worker", 45)).resolves.toBeNull();
      await expect(store.renewLease(orderId, driver, 4, 45)).resolves.toBe(true);

      // Once the driver hands the order back, recovery resumes on its usual
      // terms and the driver's stale fence can no longer move the order.
      await store.releaseLease(orderId, driver, 4);
      expect(await leaseState()).toMatchObject({ lease_owner: null, live: false });
      await ageLastTransition();
      const recovered = await store.leaseRecoverable("standard-recovery-worker", 45);
      expect(recovered).toMatchObject({ orderId, state: "RELEASE_FINAL", leaseFence: 5 });
      await expect(store.renewLease(orderId, driver, 4, 45)).resolves.toBe(false);
      await expect(store.transition(released, "DISPATCH_STARTED", "dispatch_started"))
        .rejects.toThrow("ORDER_TRANSITION_CONFLICT");
      await expect(store.transition(recovered!, "DISPATCH_STARTED", "dispatch_started"))
        .resolves.toMatchObject({ state: "DISPATCH_STARTED", version: 9, leaseFence: 5 });
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  }, 60_000);
});
