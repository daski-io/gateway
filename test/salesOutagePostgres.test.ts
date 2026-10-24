import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { PoolClient } from "pg";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { asStandardRailError, isSalesOutageRefusal } from "../src/standardRail/errors.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { createStandardMetaRouter } from "../src/standardRail/meta.js";
import { createStandardRailRouter } from "../src/standardRail/routes.js";
import { parseSalesOutageEnd, parseSalesOutageStart, SalesOutage } from "../src/standardRail/salesOutage.js";
import { StandardRailStore } from "../src/standardRail/store.js";
import type { Hex } from "../src/types.js";

const databaseUrl = process.env.DATABASE_URL_TEST ?? "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const serviceId = `0x${"ab".repeat(32)}`;
const CLAIM_UPDATE = "UPDATE standard_orders SET state='ATTEMPT_OPENED'";
const TOKEN = "sales-outage-test-token-0123456789abcdef";
const hexOf = (value: Buffer) => `0x${value.toString("hex")}` as Hex;

let admin: Pool;
let pool: Pool;
let schema: string;
let server: Server | undefined;

beforeEach(async () => {
  schema = `sales_outage_${randomUUID().replaceAll("-", "")}`;
  admin = createPool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 10 });
  await runMigrations(pool);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  await pool?.end();
  await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin?.end();
});

async function order(id: string): Promise<void> {
  const unique = () => randomBytes(32);
  await pool.query(`INSERT INTO standard_orders
    (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
     listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
     canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
    VALUES($1,$2,$1,$3,'CHALLENGE_ISSUED','7','outcome','recipe-bound-v2',$4,$5,$6,$7,'{}',$8,'{}',$9,$10,
      1000000,1,1,now()+interval '1 hour')`,
  [id, unique(), unique(), Buffer.alloc(32, 3), unique(), { commitment: { payload: { serviceId } } },
    unique(), unique(), unique(), `int_${randomUUID()}`]);
}

function claim(on: Pool, orderId: string) {
  return new StandardRailStore(on).claimAuthorization({
    orderId, expectedVersion: 0, authorizationKey: hexOf(randomBytes(32)),
    payer: "0x2222222222222222222222222222222222222222", encryptedPayload: Buffer.from("encrypted"),
    paymentPayloadHash: hexOf(randomBytes(32)), facilitatorProfileHash: hexOf(Buffer.alloc(32, 8)), capacityLimit: 10,
  });
}

/** A pool whose first statement starting with `prefix` waits, once it ran, until resumed. */
function pausedAfter(prefix: string) {
  let reached!: () => void;
  let resume!: () => void;
  const reachedPromise = new Promise<void>((yes) => { reached = yes; });
  const resumePromise = new Promise<void>((yes) => { resume = yes; });
  let paused = false;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        release: (destroy?: Error | boolean) => client.release(destroy),
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (!paused && sql.startsWith(prefix)) { paused = true; reached(); await resumePromise; }
          return result;
        },
      } as unknown as PoolClient;
    },
  };
  return { pool: wrapped as unknown as Pool, reached: reachedPromise, resume };
}

async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const waiting = await admin.query(
      "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()");
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no transaction started waiting for a lock");
}

async function audit() {
  return (await pool.query<{ revision: string; action: string; environment: string; reason: string; set_by: string;
    until: Date; previous_until: Date | null }>(
    "SELECT revision::text,action,environment,reason,set_by,until,previous_until FROM standard_sales_outage_audit ORDER BY audit_id",
  )).rows;
}

describe("sales outage state", () => {
  it("starts, extends without shortening, ends early, and audits each change", async () => {
    const outage = new SalesOutage(pool, "testnet");
    expect(await outage.status()).toEqual({ salesOpen: true });
    expect(await outage.operatorState()).toEqual({ salesOpen: true, revision: 0 });

    const started = await outage.start({ minutes: 10, reason: "Key rotation", setBy: "owner" });
    expect(started).toMatchObject({ salesOpen: false, reason: "Key rotation", setBy: "owner", revision: 1 });
    if (started.salesOpen) throw new Error("expected a paused state");
    expect(Date.parse(started.until) - Date.parse(started.since)).toBe(600_000);
    expect(Math.abs(Date.parse(started.since) - Date.now())).toBeLessThan(5_000);
    expect(await outage.status()).toEqual({ salesOpen: false, reason: "Key rotation", since: started.since, until: started.until });

    // A shorter start never shortens the window; a longer one extends it from now.
    const unchanged = await outage.start({ minutes: 2, reason: "Key rotation, step 2", setBy: "owner" });
    expect(unchanged).toMatchObject({ salesOpen: false, since: started.since, until: started.until, reason: "Key rotation, step 2" });
    const extended = await outage.start({ minutes: 30, reason: "Key rotation, step 3", setBy: "script" });
    if (extended.salesOpen) throw new Error("expected a paused state");
    expect(extended.since).toBe(started.since);
    expect(Date.parse(extended.until) - Date.parse(started.since)).toBeGreaterThanOrEqual(1_800_000);
    expect(extended.revision).toBe(3);

    const ended = await outage.end({ setBy: "owner" });
    expect(ended).toEqual({ salesOpen: true, revision: 4 });
    expect(await outage.status()).toEqual({ salesOpen: true });
    // Ending again changes nothing and records nothing.
    expect(await outage.end({ setBy: "owner" })).toEqual({ salesOpen: true, revision: 4 });

    const rows = await audit();
    expect(rows.map((row) => [row.revision, row.action, row.environment, row.set_by])).toEqual([
      ["1", "start", "testnet", "owner"], ["2", "extend", "testnet", "owner"],
      ["3", "extend", "testnet", "script"], ["4", "end", "testnet", "owner"],
    ]);
    expect(rows[1]!.previous_until?.toISOString()).toBe(started.until);
    expect(rows[3]!.previous_until?.toISOString()).toBe(extended.until);
    expect(rows[3]!.until.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("ends by itself once its end time passes, and a later start opens a new window", async () => {
    const outage = new SalesOutage(pool, "testnet");
    await outage.start({ minutes: 10, reason: "Maintenance", setBy: "owner" });
    await pool.query("UPDATE standard_sales_outage SET since=now()-interval '20 minutes',until=now()-interval '1 second'");
    expect(await outage.status()).toEqual({ salesOpen: true });
    await expect(outage.assertOpen("challenge")).resolves.toBeUndefined();
    // The expired row is not an active outage: nothing to end, and a start is new.
    expect(await outage.end({ setBy: "owner" })).toEqual({ salesOpen: true, revision: 1 });
    const restarted = await outage.start({ minutes: 5, reason: "Again", setBy: "owner" });
    if (restarted.salesOpen) throw new Error("expected a paused state");
    expect(Date.parse(restarted.until) - Date.parse(restarted.since)).toBe(300_000);
    expect((await audit()).map((row) => row.action)).toEqual(["start", "start"]);
  });

  it("refuses with SALES_PAUSED, its end time and a bounded Retry-After", async () => {
    const outage = new SalesOutage(pool, "mainnet");
    await outage.start({ minutes: 10, reason: "Provider identity switch", setBy: "owner" });
    const error = await outage.assertOpen("challenge").then(() => null, (caught: unknown) => caught);
    const classified = asStandardRailError(error);
    expect(classified).toMatchObject({ code: "SALES_PAUSED", status: 503, phase: "challenge", retryable: true,
      requiresNewSignature: false, paymentMayHaveSettled: false, reason: "Provider identity switch" });
    expect(classified!.retryAfterSeconds).toBeGreaterThan(590);
    expect(classified!.retryAfterSeconds).toBeLessThanOrEqual(600);
    const captured = await outage.assertOpen("facilitator_settle", { captured: true }).then(() => null, (caught: unknown) => caught);
    expect(asStandardRailError(captured)!.nextAction).toMatch(/^Do not sign again/);
  });
});

describe("the database fence", () => {
  it("refuses claims and settlement invocations from any runtime while active, and admits them after", async () => {
    const outage = new SalesOutage(pool, "testnet");
    await order("a");
    await order("b");
    await outage.start({ minutes: 10, reason: "Maintenance", setBy: "owner" });

    const refused = await claim(pool, "a").then(() => null, (caught: unknown) => caught);
    expect(isSalesOutageRefusal(refused)).toBe(true);
    expect((refused as Error).message).toBe("SALE_SUSPENDED");
    expect(asStandardRailError(refused)).toMatchObject({ code: "SALES_PAUSED", reason: "Maintenance" });
    // A prior runtime's own admission write meets the same refusal.
    await expect(pool.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='b'"))
      .rejects.toThrow("SALE_SUSPENDED");

    await outage.end({ setBy: "owner" });
    await expect(claim(pool, "a")).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    await outage.start({ minutes: 10, reason: "Maintenance", setBy: "owner" });
    const journal = new StandardRailJournal(pool);
    const settle = await journal.markSettleInvoked("a").then(() => null, (caught: unknown) => caught);
    expect(isSalesOutageRefusal(settle)).toBe(true);
    await outage.end({ setBy: "owner" });
    await expect(journal.markSettleInvoked("a")).resolves.toBe(true);
  });

  it("makes a start wait for an admission that locked first, then refuses that order's settlement", async () => {
    await order("a");
    const paused = pausedAfter(CLAIM_UPDATE);
    const claimA = claim(paused.pool, "a");
    await paused.reached;
    let started = false;
    const start = new SalesOutage(pool, "testnet").start({ minutes: 10, reason: "Maintenance", setBy: "owner" })
      .finally(() => { started = true; });
    await waitForLockWaiter();
    expect(started).toBe(false);
    paused.resume();
    await expect(claimA).resolves.toMatchObject({ state: "ATTEMPT_OPENED" });
    await expect(start).resolves.toMatchObject({ salesOpen: false });
    await expect(new StandardRailJournal(pool).markSettleInvoked("a")).rejects.toThrow("SALE_SUSPENDED");
  });

  it("refuses an admission that waited behind an uncommitted start", async () => {
    await order("a");
    const starter = await pool.connect();
    try {
      await starter.query("BEGIN");
      await starter.query(`UPDATE standard_sales_outage SET active=true,reason='Maintenance',set_by='owner',
        since=now(),until=now()+interval '10 minutes',revision=revision+1`);
      let settled = false;
      const claimA = claim(pool, "a").finally(() => { settled = true; });
      await waitForLockWaiter();
      expect(settled).toBe(false);
      await starter.query("COMMIT");
      await expect(claimA).rejects.toThrow("SALE_SUSPENDED");
    } finally { starter.release(); }
  });

  it("fails a snapshot taken before a start instead of admitting from it", async () => {
    await order("a");
    const legacy = await pool.connect();
    try {
      await legacy.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await legacy.query("SELECT state FROM standard_orders WHERE order_id='a'");
      await new SalesOutage(pool, "testnet").start({ minutes: 10, reason: "Maintenance", setBy: "owner" });
      await expect(legacy.query("UPDATE standard_orders SET state='ATTEMPT_OPENED' WHERE order_id='a'"))
        .rejects.toMatchObject({ code: "40001" });
      await legacy.query("ROLLBACK");
    } finally { legacy.release(); }
  });
});

describe("the outage endpoints", () => {
  async function listen() {
    const outage = new SalesOutage(pool, "testnet");
    const app = express();
    app.use(express.json());
    app.use(createStandardMetaRouter({ config: { catalogOperatorToken: TOKEN } as never, pool: {} as never,
      lifecycle: {} as never, railConfig: {} as never, service: { salesOutage: outage } as never }));
    server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    return `http://127.0.0.1:${address.port}`;
  }
  const json = { "content-type": "application/json" };
  const operator = { ...json, authorization: `Bearer ${TOKEN}` };

  it("authenticates the operator endpoints and serves the public status", async () => {
    const base = await listen();
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await fetch(`${base}/internal/release/v1/sales-outage`, { method, headers: json,
        ...(method === "POST" ? { body: JSON.stringify({ reason: "x" }) } : {}) });
      expect(response.status).toBe(401);
    }
    expect((await audit())).toEqual([]);

    const open = await fetch(`${base}/public/v1/status`);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("max-age=5");
    expect(await open.json()).toEqual({ salesOpen: true });

    const bad = await fetch(`${base}/internal/release/v1/sales-outage`, { method: "POST", headers: operator,
      body: JSON.stringify({ minutes: 61, reason: "Too long" }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: "INVALID_SALES_OUTAGE_REQUEST" } });

    const started = await fetch(`${base}/internal/release/v1/sales-outage`, { method: "POST", headers: operator,
      body: JSON.stringify({ reason: "Provider identity switch" }) });
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const body = await started.json() as { salesOpen: false; since: string; until: string };
    expect(body).toMatchObject({ salesOpen: false, reason: "Provider identity switch", setBy: "catalog-operator", revision: 1 });
    expect(Date.parse(body.until) - Date.parse(body.since)).toBe(600_000);

    const paused = await (await fetch(`${base}/public/v1/status`)).json() as Record<string, unknown>;
    expect(paused).toEqual({ salesOpen: false, reason: "Provider identity switch", since: body.since, until: body.until });
    const read = await fetch(`${base}/internal/release/v1/sales-outage`, { headers: operator });
    expect(await read.json()).toEqual({ ...paused, setBy: "catalog-operator", revision: 1 });

    const ended = await fetch(`${base}/internal/release/v1/sales-outage`, { method: "DELETE", headers: operator,
      body: JSON.stringify({ setBy: "owner" }) });
    expect(await ended.json()).toEqual({ salesOpen: true, revision: 2 });
    expect(await (await fetch(`${base}/public/v1/status`)).json()).toEqual({ salesOpen: true });
    expect((await audit()).map((row) => [row.action, row.set_by])).toEqual([["start", "catalog-operator"], ["end", "owner"]]);
  });
});

describe("outage answers on the purchase routes and readiness", () => {
  async function serve(app: express.Express) {
    server = await new Promise<Server>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    return `http://127.0.0.1:${address.port}`;
  }

  it("answers a paused challenge 503 with Retry-After, until and reason on both purchase routes", async () => {
    const outage = new SalesOutage(pool, "testnet");
    await outage.start({ minutes: 5, reason: "Provider identity switch", setBy: "owner" });
    const refuse = async () => { await outage.assertOpen("challenge"); throw new Error("unreachable"); };
    const app = express();
    app.use(express.json());
    app.use(createStandardRailRouter({ preparePaymentChallenge: refuse, issueChallenge: refuse } as never, "https://gateway.example"));
    const base = await serve(app);
    const status = await outage.status();
    if (status.salesOpen) throw new Error("expected a paused state");
    for (const path of ["/outcomes/7/outcome/quote", "/outcomes/7/outcome"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(path.endsWith("/quote") ? { request: {} } : {}) });
      expect(response.status).toBe(503);
      const retryAfter = Number(response.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(290);
      expect(retryAfter).toBeLessThanOrEqual(300);
      const body = await response.json() as { error: Record<string, unknown> };
      expect(body.error).toMatchObject({ code: "SALES_PAUSED", phase: "challenge", retryable: true, requiresNewSignature: false,
        paymentMayHaveSettled: false, until: status.until, reason: "Provider identity switch" });
    }
  });

  it("reports the outage in /health/ready without failing readiness, with setBy only for the operator", async () => {
    const outage = new SalesOutage(pool, "testnet");
    const app = express();
    app.use(createStandardMetaRouter({ config: { catalogOperatorToken: TOKEN, x402Network: "eip155:84532", chainId: 84532 } as never,
      pool, lifecycle: { isStopping: () => false } as never, railConfig: {} as never,
      service: { salesOutage: outage, signerStatuses: () => [], isAdmissionOpen: () => true, areDependenciesReady: () => true,
        operationalHealth: async () => ({}), railProfileHash: `0x${"aa".repeat(32)}` } as never }));
    const base = await serve(app);
    const open = await fetch(`${base}/health/ready`);
    expect(open.status).toBe(200);
    expect((await open.json() as { sales: unknown }).sales).toEqual({ salesOpen: true });
    await outage.start({ minutes: 10, reason: "Maintenance", setBy: "owner" });
    const status = await outage.status();
    // The public read is memoized for a second; a fresh router instance would not be.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const paused = await fetch(`${base}/health/ready`);
    expect(paused.status).toBe(200);
    expect((await paused.json() as { status: string; sales: unknown })).toMatchObject({ status: "ready", sales: status });
    const operator = await fetch(`${base}/health/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await operator.json() as { sales: unknown }).sales).toEqual({ ...status, setBy: "owner", revision: 1 });
  });
});

describe("outage requests", () => {
  it("defaults to ten minutes and allows one to sixty", () => {
    expect(parseSalesOutageStart({ reason: " Key rotation " })).toEqual({ minutes: 10, reason: "Key rotation", setBy: "catalog-operator" });
    expect(parseSalesOutageStart({ minutes: 1, reason: "a", setBy: "owner@daski" })).toEqual({ minutes: 1, reason: "a", setBy: "owner@daski" });
    expect(parseSalesOutageStart({ minutes: 60, reason: "a" }).minutes).toBe(60);
  });

  it.each([
    ["no body", undefined],
    ["no reason", { minutes: 10 }],
    ["a blank reason", { reason: "   " }],
    ["a control character", { reason: "line\nbreak" }],
    ["a long reason", { reason: "x".repeat(201) }],
    ["zero minutes", { minutes: 0, reason: "a" }],
    ["over an hour", { minutes: 61, reason: "a" }],
    ["fractional minutes", { minutes: 1.5, reason: "a" }],
    ["minutes as text", { minutes: "10", reason: "a" }],
    ["an unknown field", { reason: "a", until: "later" }],
    ["an invalid setBy", { reason: "a", setBy: "<script>" }],
    ["a list", ["a"]],
  ])("refuses %s", (_label, body) => {
    expect(() => parseSalesOutageStart(body)).toThrow("INVALID_SALES_OUTAGE_REQUEST");
  });

  it("ends with an optional setBy", () => {
    expect(parseSalesOutageEnd(undefined)).toEqual({ setBy: "catalog-operator" });
    expect(parseSalesOutageEnd({})).toEqual({ setBy: "catalog-operator" });
    expect(parseSalesOutageEnd({ setBy: "owner" })).toEqual({ setBy: "owner" });
    expect(() => parseSalesOutageEnd({ minutes: 1 })).toThrow("INVALID_SALES_OUTAGE_REQUEST");
  });
});
