import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdvisoryLockBusyError,
  tryWithAdvisoryLock,
  withAdvisoryLock,
} from "../src/db/advisoryLock.js";
import { createPool } from "../src/db/pool.js";
import { PostgresFacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("advisory locks on pooled connections", () => {
  it("answers a busy exclusive lock immediately and never queues a waiter on a client", async () => {
    const pool = createPool({ connectionString: databaseUrl, max: 2 });
    const key = `test:lock:${randomUUID()}`;
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holder = tryWithAdvisoryLock(pool, key, async () => { await held; return "held"; });
      await delay(100);
      await expect(tryWithAdvisoryLock(pool, key, async () => "second")).resolves.toEqual({ acquired: false });
      await expect(withAdvisoryLock(pool, key, async () => "second")).rejects.toBeInstanceOf(AdvisoryLockBusyError);

      const waiter = tryWithAdvisoryLock(pool, key, async () => "third", { waitMs: 5_000 });
      await delay(250);
      // The waiter polls with short-lived checkouts: with the holder on one
      // of two clients, nobody is queued for a connection while it waits.
      expect(pool.waitingCount).toBe(0);
      release();
      await expect(holder).resolves.toEqual({ acquired: true, result: "held" });
      await expect(waiter).resolves.toEqual({ acquired: true, result: "third" });
      // Released after work: a fresh attempt acquires at once.
      await expect(tryWithAdvisoryLock(pool, key, async () => "fourth")).resolves.toEqual({ acquired: true, result: "fourth" });
    } finally {
      await pool.end();
    }
  }, 20_000);

  it("lets shared holders coexist and blocks the exclusive side while they run", async () => {
    const pool = createPool({ connectionString: databaseUrl, max: 3 });
    const key = `test:lock:${randomUUID()}`;
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const first = tryWithAdvisoryLock(pool, key, async () => { await held; return 1; }, { mode: "shared" });
      await delay(100);
      await expect(tryWithAdvisoryLock(pool, key, async () => 2, { mode: "shared" })).resolves.toEqual({ acquired: true, result: 2 });
      await expect(tryWithAdvisoryLock(pool, key, async () => 3)).resolves.toEqual({ acquired: false });
      release();
      await expect(first).resolves.toEqual({ acquired: true, result: 1 });
      await expect(tryWithAdvisoryLock(pool, key, async () => 3)).resolves.toEqual({ acquired: true, result: 3 });
    } finally {
      await pool.end();
    }
  }, 20_000);

  it("releases the lock when work throws and hands a busy nonce lock back as an error", async () => {
    const pool = createPool({ connectionString: databaseUrl, max: 2 });
    const address = `0x${"11".repeat(20)}` as const;
    const lock = new PostgresFacilitatorNonceLock(pool, 84_532, address, 300);
    try {
      await expect(lock.run(async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holder = lock.run(async () => { await held; return "held"; });
      await delay(100);
      await expect(lock.run(async () => "busy")).rejects.toBeInstanceOf(AdvisoryLockBusyError);
      release();
      await expect(holder).resolves.toBe("held");
    } finally {
      await pool.end();
    }
  }, 20_000);
});
