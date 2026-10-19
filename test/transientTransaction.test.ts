import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDatabaseUnavailableError,
  runTransientTransaction,
  TRANSACTION_ATTEMPTS,
  TransactionOutcomeUnknownError,
  transactionRetryDelayMs,
  type TransactionPool,
} from "../src/db/transientTransaction.js";
import { logger } from "../src/util/logger.js";

const pgError = (code: string, message = "postgres " + code) => Object.assign(new Error(message), { code });

/** A pool whose connections record every statement and how they were released. */
function scriptedPool(fail: (sql: string, attempt: number) => Error | undefined) {
  const statements: string[][] = [];
  const releases: Array<Error | boolean | undefined> = [];
  const pool = {
    connect: async () => {
      const log: string[] = [];
      statements.push(log);
      const attempt = statements.length;
      return {
        query: async (sql: string) => {
          log.push(sql);
          const error = fail(sql, attempt);
          if (error) throw error;
          return { rows: [], rowCount: 0 };
        },
        release: (destroy?: Error | boolean) => { releases.push(destroy); },
      };
    },
  } as unknown as TransactionPool;
  return { pool, statements, releases };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("transactionRetryDelayMs", () => {
  it("jitters over a doubling window between 25 and 400 ms", () => {
    expect([1, 2, 3, 4, 9].map((retry) => transactionRetryDelayMs(retry, () => 0))).toEqual([25, 25, 25, 25, 25]);
    expect([1, 2, 3, 4, 9].map((retry) => transactionRetryDelayMs(retry, () => 1))).toEqual([100, 200, 400, 400, 400]);
    for (let retry = 1; retry <= 4; retry++) {
      for (let i = 0; i < 50; i++) {
        const delay = transactionRetryDelayMs(retry);
        expect(delay).toBeGreaterThanOrEqual(25);
        expect(delay).toBeLessThanOrEqual(400);
      }
    }
  });
});

describe("runTransientTransaction", () => {
  it("repeats the whole transaction from a fresh BEGIN after a serialization failure or deadlock", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const failures = ["40001", "40P01"];
    const { pool, statements, releases } = scriptedPool((sql, attempt) =>
      sql === "SELECT work" && attempt <= failures.length ? pgError(failures[attempt - 1]!) : undefined);
    const pauses: number[] = [];
    let runs = 0;
    const value = await runTransientTransaction(pool, async (client) => {
      runs++;
      await client.query("SELECT work", ["secret-parameter"]);
      return "claimed";
    }, { operation: "test.claim", isolation: "SERIALIZABLE", pause: async (ms) => { pauses.push(ms); }, random: () => 0.5 });
    expect(value).toBe("claimed");
    expect(runs).toBe(3);
    expect(statements).toEqual([
      ["BEGIN ISOLATION LEVEL SERIALIZABLE", "SELECT work", "ROLLBACK"],
      ["BEGIN ISOLATION LEVEL SERIALIZABLE", "SELECT work", "ROLLBACK"],
      ["BEGIN ISOLATION LEVEL SERIALIZABLE", "SELECT work", "COMMIT"],
    ]);
    // A connection that answered with a rollback goes back to the pool.
    expect(releases).toEqual([undefined, undefined, undefined]);
    expect(pauses).toEqual([63, 113]);
    expect(warn.mock.calls).toEqual([
      ["database transaction retried", { operation: "test.claim", sqlstate: "40001", attempt: 1, attempts: 4, delayMs: 63 }],
      ["database transaction retried", { operation: "test.claim", sqlstate: "40P01", attempt: 2, attempts: 4, delayMs: 113 }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-parameter");
  });

  it("defaults to READ COMMITTED and gives a transient failure back after the last attempt", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { pool, statements } = scriptedPool((sql) => sql === "SELECT work" ? pgError("40001") : undefined);
    await expect(runTransientTransaction(pool, async (client) => {
      await client.query("SELECT work");
    }, { operation: "test.claim", pause: async () => undefined })).rejects.toMatchObject({ code: "40001" });
    expect(statements).toHaveLength(TRANSACTION_ATTEMPTS);
    expect(statements.every((log) => log[0] === "BEGIN ISOLATION LEVEL READ COMMITTED")).toBe(true);
  });

  it("never repeats a refusal or any other error", async () => {
    for (const error of [new Error("OUTCOME_CAPACITY_EXHAUSTED"), pgError("23505"), pgError("P0001", "SALE_SUSPENDED")]) {
      const { pool, statements, releases } = scriptedPool(() => undefined);
      await expect(runTransientTransaction(pool, async () => { throw error; }, { operation: "test.claim" }))
        .rejects.toBe(error);
      expect(statements).toEqual([["BEGIN ISOLATION LEVEL READ COMMITTED", "ROLLBACK"]]);
      expect(releases).toEqual([undefined]);
    }
  });

  it("retries a serialization failure reported at COMMIT, which rolled the transaction back", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { pool, statements } = scriptedPool((sql, attempt) => sql === "COMMIT" && attempt === 1 ? pgError("40001") : undefined);
    await expect(runTransientTransaction(pool, async () => "done", { operation: "test.claim", pause: async () => undefined }))
      .resolves.toBe("done");
    expect(statements.map((log) => log.at(-1))).toEqual(["COMMIT", "COMMIT"]);
  });

  it("reports a lost COMMIT as an unknown outcome, discards its connection and never repeats it", async () => {
    const lost = new Error("Connection terminated unexpectedly");
    const { pool, statements, releases } = scriptedPool((sql) => sql === "COMMIT" ? lost : undefined);
    const outcome = runTransientTransaction(pool, async () => "maybe", { operation: "test.claim" });
    await expect(outcome).rejects.toBeInstanceOf(TransactionOutcomeUnknownError);
    await expect(outcome).rejects.toMatchObject({ cause: lost });
    expect(statements).toHaveLength(1);
    expect(releases).toEqual([lost]);
    expect(isDatabaseUnavailableError(await outcome.catch((error: unknown) => error))).toBe(false);
  });

  it("discards a connection that cannot even roll back, keeping the original failure", async () => {
    const lost = new Error("Connection terminated unexpectedly");
    const { pool, releases } = scriptedPool((sql) => sql === "SELECT work" || sql === "ROLLBACK" ? lost : undefined);
    await expect(runTransientTransaction(pool, async (client) => { await client.query("SELECT work"); }, { operation: "test.claim" }))
      .rejects.toBe(lost);
    expect(releases).toEqual([lost]);
  });
});

describe("isDatabaseUnavailableError", () => {
  it("names the failures that ended the work before it committed", () => {
    for (const code of ["40001", "40P01", "08006", "08001", "53300", "57P01", "57P03", "57014", "55P03"]) {
      expect(isDatabaseUnavailableError(pgError(code)), code).toBe(true);
    }
    for (const error of [
      new Error("Connection terminated unexpectedly"),
      new Error("timeout exceeded when trying to connect"),
      new Error("Client has encountered a connection error and is not queryable"),
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    ]) expect(isDatabaseUnavailableError(error), error.message).toBe(true);
  });

  it("keeps decisions, unknown outcomes and other faults out", () => {
    for (const code of ["23505", "P0001", "08007", "40003", "42P01", "XX000"]) {
      expect(isDatabaseUnavailableError(pgError(code)), code).toBe(false);
    }
    for (const error of [
      new Error("OUTCOME_CAPACITY_EXHAUSTED"),
      new Error("SALE_SUSPENDED"),
      new TransactionOutcomeUnknownError("test.claim", new Error("Connection terminated unexpectedly")),
      "Connection terminated unexpectedly",
    ]) expect(isDatabaseUnavailableError(error)).toBe(false);
  });
});
