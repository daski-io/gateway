import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { StandardRailOperator } from "../src/standardRail/operator.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import { assertTransition, isTerminalState } from "../src/standardRail/stateMachine.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const orderId = "ord_12345678-1234-4123-8123-123456789abc";
async function fixture(work: (pool: Pool) => Promise<void>) {
  const schema = `operator_recovery_${randomUUID().replaceAll("-", "")}`;
  const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 4 });
  try {
    // Existing failed orders survive expansion unchanged, including old claims.
    await runMigrations(pool, { through: "047_binding_profiles_current.sql" });
    await pool.query(`INSERT INTO standard_orders (
      order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,
      binding_profile,listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,
      canonical_quote,canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,
      rail_epoch,listing_epoch,version,lease_fence,expires_at,updated_at)
      VALUES ($1,$2,'handle-1',$2,'PROVIDER_FAILED','7','outcome','recipe-bound-v2',$2,$2,'{}',$2,
        '{}',$2,'{}',$2,'int_12345678-1234-4123-8123-123456789abc',1000000,1,1,7,2,now(),now())`,
      [orderId, Buffer.alloc(32, 1)]);
    await pool.query(`INSERT INTO standard_dispatch_claims
      (order_id,dispatch_nonce,dispatch_hash,request_hash,invocation_state,canonical_dispatch,canonical_request)
      VALUES ($1,$2,$2,$2,'invoked','{"old":true}','{}')`, [orderId, Buffer.alloc(32, 2)]);
    await runMigrations(pool);
    expect((await pool.query("SELECT canonical_dispatch FROM standard_dispatch_claims")).rows[0].canonical_dispatch).toEqual({ old: true });
    await work(pool);
  } finally {
    await pool.end(); await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`); await bootstrap.end();
  }
}
async function release(pool: Pool) {
  await pool.query(`INSERT INTO standard_chain_evidence
    (evidence_hash,order_id,evidence_kind,chain_id,block_number,block_hash,transaction_hash,
     transaction_index,log_index,source_fingerprints,canonical_evidence,observed_at)
    VALUES ($1,$2,'release',8453,1,'block','tx',0,0,'[]','{}',now()-interval '2 hours')`,
    [Buffer.alloc(32, 3), orderId]);
}
async function operation(pool: Pool, state: string, reason: string | null = null) {
  const id = randomUUID();
  await pool.query(`INSERT INTO standard_reputation_operations
    (operation_id,order_id,kind,logical_key,intent_hash,canonical_intent,state,next_attempt_at,last_error_class,attempts)
    VALUES ($1,$2,'register',$3,$3,'{}',$4,now()+interval '1 day',$5,4)`,
    [id, orderId, Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex"), state, reason]);
  return id;
}
async function transaction(pool: Pool, operationId: string, state: string) {
  const result = await pool.query(`INSERT INTO standard_reputation_transactions
    (operation_id,chain_id,relayer_address,nonce,destination,value,intent_hash,calldata_hash,
     encrypted_raw_transaction,transaction_hash,state)
    VALUES ($1,8453,'relayer',1,'destination',0,$2,$2,$2,$3,$4) RETURNING transaction_id`,
    [operationId, Buffer.alloc(32, 4), `0x${"55".repeat(32)}`, state]);
  return result.rows[0].transaction_id;
}

describe("operator and dispatch recovery (postgres)", () => {
  it("revives a released failed order once under concurrent requests and audits the old claim", async () => fixture(async (pool) => {
    await release(pool);
    const operator = new StandardRailOperator(pool);
    const results = await Promise.allSettled([operator.redispatch(orderId), operator.redispatch(orderId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const changed = (await pool.query("SELECT state,version,lease_fence FROM standard_orders")).rows[0];
    expect(changed).toMatchObject({ state: "RELEASE_FINAL", version: "8", lease_fence: "3" });
    expect((await pool.query("SELECT reason_code FROM standard_order_transitions")).rows).toEqual([{ reason_code: "operator_redispatch" }]);
    const audit = (await pool.query("SELECT * FROM standard_operator_actions")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details.previousClaim.canonical_dispatch).toEqual({ old: true });
    expect((await pool.query("SELECT * FROM standard_dispatch_claims")).rows).toHaveLength(0);
    const recovery = await new StandardRailJournal(pool).dispatchRecovery(orderId);
    expect(recovery.claim_id).toBe(audit[0].details.claimId);
    expect(Date.now() - recovery.started_at.getTime()).toBeLessThan(5000);
    expect(isTerminalState("PROVIDER_FAILED")).toBe(true);
    expect(() => assertTransition("PROVIDER_FAILED", "DISPATCHED")).toThrow();
  }), 60_000);

  it("refuses missing evidence, a provider task, a resolved claim, a live driver and other states without mutation", async () => fixture(async (pool) => {
    const operator = new StandardRailOperator(pool);
    await expect(operator.redispatch(orderId)).rejects.toThrow("release_evidence_missing");
    await release(pool);
    await pool.query("UPDATE standard_orders SET provider_task_id='task'");
    await expect(operator.redispatch(orderId)).rejects.toThrow("provider_task_already_assigned");
    await pool.query("UPDATE standard_orders SET provider_task_id=NULL");
    await pool.query("UPDATE standard_dispatch_claims SET resolved_at=now()");
    await expect(operator.redispatch(orderId)).rejects.toThrow("dispatch_claim_resolved");
    await pool.query("UPDATE standard_dispatch_claims SET resolved_at=NULL");
    await pool.query("UPDATE standard_orders SET lease_until=now()+interval '1 minute'");
    await expect(operator.redispatch(orderId)).rejects.toThrow("order_driver_active");
    await pool.query("UPDATE standard_orders SET state='DISPATCHED',lease_until=NULL");
    await expect(operator.redispatch(orderId)).rejects.toThrow("order_not_provider_failed");
    expect((await pool.query("SELECT * FROM standard_operator_actions")).rows).toHaveLength(0);
  }), 60_000);

  it("records refusal reasons and caps durable backoff at 60 seconds", async () => fixture(async (pool) => {
    await release(pool);
    const journal = new StandardRailJournal(pool);
    const recovery = await journal.dispatchRecovery(orderId);
    expect(Date.now() - recovery.started_at.getTime()).toBeGreaterThan(7100_000);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await pool.query("UPDATE standard_dispatch_recovery SET retry_pending=false");
      await journal.recordDispatchRefusal(orderId, `0x${"02".repeat(32)}`, 409, { code: "NOT_READY" });
      const row = (await pool.query("SELECT retry_pending,round(extract(epoch FROM next_attempt_at-now()))::int AS delay FROM standard_dispatch_recovery")).rows[0];
      expect(row.retry_pending).toBe(true); delays.push(row.delay);
    }
    expect(delays).toEqual([10,20,40,60,60,60]);
    expect((await pool.query("SELECT http_status,reason FROM standard_dispatch_refusals")).rows).toEqual(
      Array.from({ length: 6 }, () => ({ http_status: 409, reason: { code: "NOT_READY" } })),
    );
    // Ordinary transition calls cannot use the operator-only edge.
    const store = new StandardRailStore(pool);
    await expect(store.transition((await store.findById(orderId))!, "RELEASE_FINAL", "operator_redispatch"))
      .rejects.toThrow("OPERATOR_REDISPATCH_REQUIRED");
  }), 60_000);

  it("brings pending work forward and replaces only a nonce-conflicted unsendable transaction", async () => fixture(async (pool) => {
    const operator = new StandardRailOperator(pool);
    const pending = await operation(pool, "pending");
    await expect(operator.retryReputation(pending)).resolves.toMatchObject({ state: "pending" });
    expect((await pool.query("SELECT next_attempt_at<=now() AS due,attempts FROM standard_reputation_operations WHERE operation_id=$1", [pending])).rows[0]).toEqual({ due: true, attempts: 4 });
    const conflicted = await operation(pool, "operator_attention", "nonce_conflict");
    const tx = await transaction(pool, conflicted, "prepared");
    await operator.retryReputation(conflicted);
    expect((await pool.query("SELECT state FROM standard_reputation_transactions WHERE transaction_id=$1", [tx])).rows[0].state).toBe("failed");
    expect((await pool.query("SELECT state,attempts FROM standard_reputation_operations WHERE operation_id=$1", [conflicted])).rows[0]).toEqual({ state: "pending", attempts: 0 });
    const alreadyFailed = await operation(pool, "operator_attention", "nonce_conflict");
    await expect(operator.retryReputation(alreadyFailed)).resolves.toMatchObject({ state: "pending" });
    for (const state of ["broadcast", "final", "aborted_unattested", "blocked_parent_aborted", "operator_attention"]) {
      await expect(operator.retryReputation(await operation(pool, state, "balance_fee"))).rejects.toThrow("operation_not_retryable");
    }
    const unsafe = await operation(pool, "pending");
    await transaction(pool, unsafe, "broadcast");
    await expect(operator.retryReputation(unsafe)).rejects.toThrow("transaction_broadcast_or_final");
    expect((await pool.query("SELECT * FROM standard_operator_actions")).rows).toHaveLength(3);
  }), 60_000);
});
