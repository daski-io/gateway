import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardRailJournal } from "../src/standardRail/journal.js";
import { StandardWalletStore } from "../src/standardRail/walletStore.js";

/// 2026-09-01: wallet and order-action challenge issuance ran SERIALIZABLE with
/// the advisory lock as the first statement, so the snapshot predated the lock
/// and concurrent issuers hit serialization failures — surfaced to clients as an
/// unlogged, non-retryable WALLET_ACCESS_DENIED (1–3 of every 10 parallel
/// lookups on the live gateway). These tests drive the real stores against a
/// real database: every concurrent issuance must succeed, and the outstanding
/// cap must still be enforced exactly under the same concurrency.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const CHAIN_ID = 84532;
const PAYER = "0x1111111111111111111111111111111111111111";
const CLIENT_KEY = Buffer.alloc(32, 5);

function config(outstandingPerClient: number): StandardRailConfig {
  return {
    encryptionKey: Buffer.alloc(32, 7),
    gatewayAudience: "https://gateway.example",
    environment: "testnet",
    abuse: {
      walletChallengesOutstandingPerClient: outstandingPerClient,
      walletChallengesOutstandingGlobal: 10_000,
      walletChallengesPerClientPerMinute: 1_000,
      walletChallengesGlobalPerMinute: 10_000,
      assetListsPerPayerPerMinute: 1_000,
      protectedReadsPerPayerPerMinute: 1_000,
      assetStateChangesPerPayerPerMinute: 1_000,
    },
  } as unknown as StandardRailConfig;
}

const schema = `challenge_concurrency_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 25 });
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

function issueWallet(store: StandardWalletStore, index: number) {
  return store.issue({
    action: "list-orders",
    payer: PAYER,
    request: { limit: 25, cursor: null, paymentIdentifier: `int_${String(index).padStart(32, "0")}` },
    absoluteResourceUri: "https://gateway.example/wallet/orders",
    clientKey: "203.0.113.7",
  });
}

function issueAction(journal: StandardRailJournal, index: number, caps: { perClient: number }) {
  const now = Math.floor(Date.now() / 1_000);
  return journal.issueActionChallenge({
    orderId: null,
    action: "status",
    requestHash: `0x${"ab".repeat(32)}`,
    absoluteResourceUri: `https://gateway.example/orders/h${index}/actions/status`,
    nonce: `0x${index.toString(16).padStart(64, "0")}`,
    issuedAt: now,
    validBefore: now + 300,
    clientKeyHash: CLIENT_KEY,
    outstandingPerClient: caps.perClient,
    outstandingGlobal: 10_000,
  });
}

async function clearChallenges() {
  await pool.query("DELETE FROM standard_wallet_action_challenges");
  await pool.query("DELETE FROM standard_action_challenges");
}

describe("challenge issuance under concurrency", () => {
  it("issues 20 wallet challenges concurrently for one client without a single refusal", async () => {
    await clearChallenges();
    const store = new StandardWalletStore(pool, config(100), CHAIN_ID);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => issueWallet(store, i)));
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failures.map((f) => String(f.reason))).toEqual([]);
    const rows = await pool.query("SELECT count(*)::int AS n FROM standard_wallet_action_challenges");
    expect(rows.rows[0].n).toBe(20);
  }, 60_000);

  it("issues 20 order-action challenges concurrently without a single refusal", async () => {
    await clearChallenges();
    const journal = new StandardRailJournal(pool);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => issueAction(journal, i, { perClient: 100 })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const rows = await pool.query("SELECT count(*)::int AS n FROM standard_action_challenges");
    expect(rows.rows[0].n).toBe(20);
  }, 60_000);

  it("issues wallet and order-action challenges concurrently across the shared lock", async () => {
    await clearChallenges();
    const store = new StandardWalletStore(pool, config(100), CHAIN_ID);
    const journal = new StandardRailJournal(pool);
    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => issueWallet(store, i)),
      ...Array.from({ length: 10 }, (_, i) => issueAction(journal, i, { perClient: 100 })),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
  }, 60_000);

  it("still enforces the outstanding cap exactly under the same concurrency", async () => {
    // The lock, not the isolation level, is what makes the count correct: with
    // a cap of 5, exactly 5 of 20 simultaneous issuers may succeed.
    await clearChallenges();
    const store = new StandardWalletStore(pool, config(5), CHAIN_ID);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => issueWallet(store, i)));
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter(
      (r) => r.status === "rejected" && String((r as PromiseRejectedResult).reason.message) === "wallet authorization denied",
    ).length;
    expect(fulfilled).toBe(5);
    expect(refused).toBe(15);
    const rows = await pool.query("SELECT count(*)::int AS n FROM standard_wallet_action_challenges");
    expect(rows.rows[0].n).toBe(5);
  }, 60_000);
});
