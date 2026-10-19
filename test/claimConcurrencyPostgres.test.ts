import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { runTransientTransaction } from "../src/db/transientTransaction.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { ReleaseRetirements, RetirementBlocked } from "../src/standardRail/releaseRetirements.js";
import { ReleaseSales } from "../src/standardRail/releaseSales.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import type { Hex } from "../src/types.js";
import { logger } from "../src/util/logger.js";

// The purchase claim's concurrency against PostgreSQL 16. Each interleaving
// is forced: a claim is paused right after a chosen statement while another
// transaction commits, then resumed. SERIALIZABLE answered the first two
// cases below with 40001 for the resumed claim; READ COMMITTED with the
// locks taken before the dependent reads resolves every case on its first
// attempt, and the release fences still refuse what they refused.

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const serviceId = `0x${"ab".repeat(32)}`;
const PAYER = "0x2222222222222222222222222222222222222222" as Hex;
const FIRST_READ = "SELECT order_id FROM standard_orders WHERE authorization_key";
const CLAIM_UPDATE = "UPDATE standard_orders SET state='ATTEMPT_OPENED'";
const listing = (n: number) => Buffer.alloc(32, n);
const hexOf = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
const randomHash = () => hexOf(randomBytes(32));

let admin: Pool;
let pool: Pool;
let schema: string;

beforeEach(async () => {
  schema = `claim_concurrency_${randomUUID().replaceAll("-", "")}`;
  admin = createPool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 30 });
  await runMigrations(pool);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await pool?.end();
  await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin?.end();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function order(id: string, listingByte: number): Promise<void> {
  const unique = () => randomBytes(32);
  await pool.query(`INSERT INTO standard_orders
    (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
     listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
     canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
    VALUES($1,$2,$1,$3,'CHALLENGE_ISSUED','7','outcome','recipe-bound-v2',$4,$5,$6,$7,'{}',$8,'{}',$9,$10,
      1000000,1,1,now()+interval '1 hour')`,
  [id, unique(), unique(), listing(listingByte), unique(), { commitment: { payload: { serviceId } } },
    unique(), unique(), unique(), `int_${randomUUID()}`]);
}

interface Observed { begins: number; sqlstates: string[] }

/**
 * The pool a claim runs on, counting its transaction attempts and every
 * SQLSTATE a statement failed with; `after` runs once a statement succeeded.
 */
function observed(after?: (sql: string) => Promise<void>): { pool: Pool; seen: Observed } {
  const seen: Observed = { begins: 0, sqlstates: [] };
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        release: (destroy?: Error | boolean) => client.release(destroy),
        query: async (sql: string, values?: unknown[]) => {
          if (sql.startsWith("BEGIN")) seen.begins++;
          let result;
          try {
            result = await client.query(sql, values);
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (typeof code === "string") seen.sqlstates.push(code);
            throw error;
          }
          await after?.(sql);
          return result;
        },
      } as unknown as PoolClient;
    },
  };
  return { pool: wrapped as unknown as Pool, seen };
}

/** Holds the first statement starting with `prefix` until resumed. */
function pauseAfter(prefix: string) {
  const reached = deferred();
  const resume = deferred();
  let paused = false;
  return {
    reached: reached.promise,
    resume: () => resume.resolve(),
    hook: async (sql: string) => {
      if (paused || !sql.startsWith(prefix)) return;
      paused = true;
      reached.resolve();
      await resume.promise;
    },
  };
}

function claim(on: Pool, orderId: string, capacityLimit: number, authorizationKey: Hex = randomHash()) {
  return new StandardRailStore(on).claimAuthorization({
    orderId, expectedVersion: 0, authorizationKey, payer: PAYER,
    encryptedPayload: Buffer.from("encrypted"), paymentPayloadHash: randomHash(),
    facilitatorProfileHash: hexOf(Buffer.alloc(32, 8)), capacityLimit,
  });
}

async function openReservations(listingByte: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM standard_capacity_reservations WHERE listing_manifest_hash=$1 AND state='open'",
    [listing(listingByte)]);
  return Number(result.rows[0]!.count);
}

async function orderState(orderId: string) {
  const result = await pool.query<{ state: string; version: string; attempts: string }>(
    `SELECT o.state,o.version::text AS version,
       (SELECT count(*) FROM standard_settlement_attempts a WHERE a.order_id=o.order_id)::text AS attempts
       FROM standard_orders o WHERE o.order_id=$1`, [orderId]);
  const row = result.rows[0]!;
  return { state: row.state, version: Number(row.version), attempts: Number(row.attempts) };
}

describe("purchase claims under concurrency", () => {
  it("resumes a claim behind a committed claim of the same listing and admits both while capacity allows", async () => {
    await order("a", 3);
    await order("b", 3);
    const pause = pauseAfter(FIRST_READ);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 10);
    await pause.reached;
    await expect(claim(pool, "b", 10)).resolves.toMatchObject({ orderId: "b", state: "ATTEMPT_OPENED" });
    pause.resume();
    await expect(claimA).resolves.toMatchObject({ orderId: "a", state: "ATTEMPT_OPENED", version: 1 });
    expect(a.seen).toEqual({ begins: 1, sqlstates: [] });
    expect(await openReservations(3)).toBe(2);
  });

  it("refuses the resumed claim by name when the committed claim took the last capacity", async () => {
    await order("a", 3);
    await order("b", 3);
    const pause = pauseAfter(FIRST_READ);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 1);
    await pause.reached;
    await expect(claim(pool, "b", 1)).resolves.toMatchObject({ orderId: "b", state: "ATTEMPT_OPENED" });
    pause.resume();
    await expect(claimA).rejects.toThrow("OUTCOME_CAPACITY_EXHAUSTED");
    expect(a.seen).toEqual({ begins: 1, sqlstates: [] });
    expect(await openReservations(3)).toBe(1);
    // Nothing of the refused claim remains: the order can still be paid later.
    expect(await orderState("a")).toEqual({ state: "CHALLENGE_ISSUED", version: 0, attempts: 0 });
  });

  it("never lets claims of different listings abort each other", async () => {
    await order("a", 3);
    await order("b", 4);
    const pause = pauseAfter(FIRST_READ);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 1);
    await pause.reached;
    await expect(claim(pool, "b", 1)).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    pause.resume();
    await expect(claimA).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    expect(a.seen).toEqual({ begins: 1, sqlstates: [] });
    expect([await openReservations(3), await openReservations(4)]).toEqual([1, 1]);
  });

  it("admits exactly the capacity from a 20-way burst on one listing without a serialization failure", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `burst-${index}`);
    for (const id of ids) await order(id, 5);
    const burst = observed();
    const warn = vi.spyOn(logger, "warn");
    const outcomes = await Promise.allSettled(ids.map((id) => claim(burst.pool, id, 5)));
    const admitted = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(admitted).toHaveLength(5);
    expect(refused.map((outcome) => (outcome.reason as Error).message))
      .toEqual(Array(15).fill("OUTCOME_CAPACITY_EXHAUSTED"));
    expect(burst.seen).toEqual({ begins: 20, sqlstates: [] });
    expect(warn).not.toHaveBeenCalledWith("database transaction retried", expect.anything());
    expect(await openReservations(5)).toBe(5);
    const states = await pool.query<{ state: string; count: string }>(
      "SELECT state,count(*)::text AS count FROM standard_orders GROUP BY state ORDER BY state");
    expect(states.rows).toEqual([
      { state: "ATTEMPT_OPENED", count: "5" },
      { state: "CHALLENGE_ISSUED", count: "15" },
    ]);
  });

  it("keeps each listing's capacity in a burst across listings", async () => {
    const ids: Array<[string, number]> = [];
    for (let listingByte = 6; listingByte < 10; listingByte++) {
      for (let index = 0; index < 5; index++) ids.push([`l${listingByte}-${index}`, listingByte]);
    }
    for (const [id, listingByte] of ids) await order(id, listingByte);
    const burst = observed();
    const outcomes = await Promise.allSettled(ids.map(([id]) => claim(burst.pool, id, 2)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(8);
    expect(burst.seen).toEqual({ begins: 20, sqlstates: [] });
    for (let listingByte = 6; listingByte < 10; listingByte++) expect(await openReservations(listingByte)).toBe(2);
  });

  it("admits one of two identical concurrent claims and refuses the other by name", async () => {
    await order("a", 3);
    const key = randomHash();
    const burst = observed();
    const outcomes = await Promise.allSettled([claim(burst.pool, "a", 10, key), claim(burst.pool, "a", 10, key)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")!;
    expect((refused.reason as Error).message).toBe("ORDER_ADMISSION_CONFLICT");
    expect(burst.seen).toEqual({ begins: 2, sqlstates: [] });
    expect(await openReservations(3)).toBe(1);
  });

  it("keeps one order per authorization through the unique index when another order claims it concurrently", async () => {
    await order("a", 3);
    await order("b", 3);
    const key = randomHash();
    const pause = pauseAfter(FIRST_READ);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 10, key);
    await pause.reached;
    await expect(claim(pool, "b", 10, key)).resolves.toMatchObject({ orderId: "b" });
    pause.resume();
    await expect(claimA).rejects.toThrow("PAYMENT_AUTHORIZATION_ALREADY_CLAIMED");
    // The resumed claim's first read predates the other claim: the index decides.
    expect(a.seen).toEqual({ begins: 1, sqlstates: ["23505"] });
    expect(await orderState("a")).toEqual({ state: "CHALLENGE_ISSUED", version: 0, attempts: 0 });
    expect(await openReservations(3)).toBe(1);
    // A later claim finds the committed holder in its first read.
    await order("c", 3);
    const c = observed();
    await expect(claim(c.pool, "c", 10, key)).rejects.toThrow("PAYMENT_AUTHORIZATION_ALREADY_CLAIMED");
    expect(c.seen).toEqual({ begins: 1, sqlstates: [] });
  });
});

describe("release fences around a READ COMMITTED claim", () => {
  const scope = { providerAgentId: "7", serviceId, listingManifestHash: hexOf(listing(3)) };

  it("refuses a claim resumed after a stop committed, on its first attempt", async () => {
    await order("a", 3);
    const pause = pauseAfter(FIRST_READ);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 10);
    await pause.reached;
    await new ReleaseSales(pool).set({ ...scope, requestId: "stop-during-claim", expectedRevision: 0, acceptingNewOrders: false });
    pause.resume();
    await expect(claimA).rejects.toThrow("SALE_SUSPENDED");
    expect(a.seen).toEqual({ begins: 1, sqlstates: ["P0001"] });
    expect(await orderState("a")).toEqual({ state: "CHALLENGE_ISSUED", version: 0, attempts: 0 });
    expect(await openReservations(3)).toBe(0);
  });

  it("makes a stop wait for an admitting claim, then parks its authorization", async () => {
    await order("a", 3);
    const pause = pauseAfter(CLAIM_UPDATE);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 10);
    await pause.reached;
    let stopped = false;
    const stop = new ReleaseSales(pool)
      .set({ ...scope, requestId: "stop-after-claim", expectedRevision: 0, acceptingNewOrders: false })
      .finally(() => { stopped = true; });
    await waitForLockWaiter();
    expect(stopped).toBe(false);
    pause.resume();
    await expect(claimA).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    await expect(stop).resolves.toMatchObject({ revision: 1, acceptingNewOrders: false });
    expect((await pool.query("SELECT order_id,sale_revision::int FROM standard_parked_authorizations")).rows)
      .toEqual([{ order_id: "a", sale_revision: 1 }]);
    await expect(new StandardRailJournal(pool).markSettleInvoked("a")).rejects.toThrow("SALE_SUSPENDED");
    expect(a.seen).toEqual({ begins: 1, sqlstates: [] });
  });

  it("makes a retirement wait for an admitting claim, then refuse the claimed order's obligation", async () => {
    await order("a", 3);
    const retirements = new ReleaseRetirements(pool, {
      environment: "test", chainId: 84532, privateKey: `0x${"11".repeat(32)}`,
      providerAudience: () => "https://provider.test",
    });
    const pause = pauseAfter(CLAIM_UPDATE);
    const a = observed(pause.hook);
    const claimA = claim(a.pool, "a", 10);
    await pause.reached;
    let finished = false;
    const retirement = retirements.retire({ kind: "listing", ...scope, requestId: "retire-during-claim" })
      .catch((error: unknown) => error).finally(() => { finished = true; });
    await waitForLockWaiter();
    expect(finished).toBe(false);
    pause.resume();
    await expect(claimA).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    const refused = await retirement;
    expect(refused).toBeInstanceOf(RetirementBlocked);
    expect((refused as RetirementBlocked).blockers).toMatchObject({ openOrders: 1, capacityReservations: 1 });
    expect(a.seen).toEqual({ begins: 1, sqlstates: [] });
  });
});

describe("a claim attempt that Postgres rolls back", () => {
  it("is repeated whole: every read and write runs again and nothing of the aborted attempt remains", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await order("a", 3);
    let injected = 0;
    const flaky = {
      connect: async () => {
        const client = await pool.connect();
        return {
          release: (destroy?: Error | boolean) => client.release(destroy),
          query: async (sql: string, values?: unknown[]) => {
            // The attempt's last write: the reservation, order update and
            // settlement attempt before it already ran in this transaction.
            if (sql.includes("INSERT INTO standard_order_transitions") && injected++ === 0) {
              throw Object.assign(new Error("could not serialize access"), { code: "40001" });
            }
            return client.query(sql, values);
          },
        } as unknown as PoolClient;
      },
    };
    const statements: string[] = [];
    const counting = {
      connect: async () => {
        const client = await flaky.connect();
        return {
          release: client.release,
          query: async (sql: string, values?: unknown[]) => { statements.push(sql.split(/\s+/).slice(0, 3).join(" ")); return client.query(sql, values); },
        } as unknown as PoolClient;
      },
    };
    await expect(claim(counting as unknown as Pool, "a", 1)).resolves.toMatchObject({ state: "ATTEMPT_OPENED", version: 1 });
    const begins = statements.filter((sql) => sql.startsWith("BEGIN")).length;
    expect(begins).toBe(2);
    expect(statements.filter((sql) => sql.startsWith("SELECT count(*)::text")).length).toBe(2);
    expect(await openReservations(3)).toBe(1);
    expect(await orderState("a")).toEqual({ state: "ATTEMPT_OPENED", version: 1, attempts: 1 });
    expect((await pool.query("SELECT count(*)::int AS count FROM standard_order_transitions WHERE order_id='a' AND reason_code='authorization_claimed'")).rows[0].count).toBe(1);
  });

  it("retries a real deadlock victim from a fresh transaction", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await pool.query("CREATE TABLE deadlock_rows(id int PRIMARY KEY, value int NOT NULL)");
    await pool.query("INSERT INTO deadlock_rows VALUES (1,0),(2,0)");
    const holder = await pool.connect();
    const firstLock = deferred();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE deadlock_rows SET value=value+1 WHERE id=2");
      let attempt = 0;
      const victim = runTransientTransaction(pool, async (client) => {
        attempt++;
        await client.query("UPDATE deadlock_rows SET value=value+10 WHERE id=1");
        if (attempt === 1) firstLock.resolve();
        await client.query("UPDATE deadlock_rows SET value=value+10 WHERE id=2");
        return attempt;
      }, { operation: "test.deadlock" });
      await firstLock.promise;
      // The holder now waits for row 1 while the victim waits for row 2: one
      // of the two is chosen as the deadlock victim after deadlock_timeout.
      const closing = holder.query("UPDATE deadlock_rows SET value=value+1 WHERE id=1")
        .then(() => holder.query("COMMIT"), async (error: unknown) => { await holder.query("ROLLBACK"); throw error; });
      const [held, retried] = await Promise.allSettled([closing, victim]);
      if (held.status === "rejected") {
        // Postgres chose the holder; the transaction under test committed on its first attempt.
        expect(held.reason).toMatchObject({ code: "40P01" });
        expect(retried).toEqual({ status: "fulfilled", value: 1 });
      } else {
        expect(retried).toEqual({ status: "fulfilled", value: 2 });
        expect(warn).toHaveBeenCalledWith("database transaction retried", expect.objectContaining({
          operation: "test.deadlock", sqlstate: "40P01", attempt: 1,
        }));
      }
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }, 30_000);
});

/** Waits until some backend of this test database is waiting for a lock. */
async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const waiting = await admin.query(
      "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()");
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no transaction started waiting for a lock");
}
