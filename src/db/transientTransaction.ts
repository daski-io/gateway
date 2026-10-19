import type { PoolClient } from "pg";
import type { Pool } from "./pool.js";
import { isTransientDatabaseError } from "../standardRail/errors.js";
import { logger } from "../util/logger.js";

/** A pool, or anything that hands out its connections. */
export type TransactionPool = Pick<Pool, "connect">;

export type TransactionIsolation = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

/** Attempts of one transaction, the first included. */
export const TRANSACTION_ATTEMPTS = 4;
const RETRY_DELAY_FLOOR_MS = 25;
const RETRY_DELAY_CEILING_MS = 400;

/**
 * COMMIT was sent and no answer proved a rollback: the connection failed, or
 * the server reported an error that does not say the transaction was rolled
 * back. The work may have committed, so the caller must look before treating
 * it as not done.
 */
export class TransactionOutcomeUnknownError extends Error {
  constructor(readonly operation: string, cause: unknown) {
    super(`DATABASE_COMMIT_OUTCOME_UNKNOWN:${operation}`, { cause });
    this.name = "TransactionOutcomeUnknownError";
  }
}

// A PostgreSQL SQLSTATE: a class of a digit and a character, a letter and a
// digit (F0, P0), or HV or XX, then three characters. Node's errno codes
// (EPIPE, ECONNRESET) are never one.
const SQLSTATE = /^(?:[0-9][0-9A-Z]|[A-Z][0-9]|HV|XX)[0-9A-Z]{3}$/;

export function sqlState(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
}

// SQLSTATEs the server answers before or instead of doing the work: the
// connection was refused or lost (class 08, but not 08007, whose outcome is
// unknown), too many connections (53300), the server is shutting down or
// starting (57P01-57P03), a statement or lock timeout cancelled the work
// (57014, 55P03), or the transaction was rolled back as a serialization
// failure or deadlock victim (40001, 40P01). Ending a statement before
// COMMIT, none of them leaves any of the work committed.
const UNAVAILABLE_SQLSTATES = new Set([
  "08000", "08001", "08003", "08004", "08006", "53300",
  "57P01", "57P02", "57P03", "57014", "55P03", "40001", "40P01",
]);
// The client-side failures that node-postgres and Node report for the same
// conditions, without a SQLSTATE.
const UNAVAILABLE_SOCKET_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
]);
const UNAVAILABLE_CLIENT_MESSAGES = [
  /^Connection terminated/,
  /^timeout exceeded when trying to connect$/,
  /^Client has encountered a connection error and is not queryable$/,
  /^Client was closed and is not queryable$/,
  /^Cannot use a pool after calling end on the pool$/,
];

/**
 * The database could not do the work this time and kept none of it, so the
 * same request can succeed later. True only for an error that ended the work
 * before COMMIT was sent, or that the server answered with a rollback; a lost
 * COMMIT is a TransactionOutcomeUnknownError instead.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  if (error instanceof TransactionOutcomeUnknownError) return false;
  const state = sqlState(error);
  if (state) return UNAVAILABLE_SQLSTATES.has(state);
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNAVAILABLE_SOCKET_CODES.has(code)) return true;
  return UNAVAILABLE_CLIENT_MESSAGES.some((pattern) => pattern.test(error.message));
}

/**
 * The pause before retry `retry` (1 for the first retry): full jitter over a
 * window whose ceiling doubles from 100 ms to 400 ms, never below 25 ms, so
 * transactions that collided once do not collide again in step.
 */
export function transactionRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_DELAY_CEILING_MS, 100 * 2 ** Math.max(0, retry - 1));
  return Math.round(RETRY_DELAY_FLOOR_MS + random() * (ceiling - RETRY_DELAY_FLOOR_MS));
}

export interface TransientTransactionOptions {
  /** Names the work in the retry log line; parameters are never logged. */
  operation: string;
  /** READ COMMITTED unless set: the server default, made explicit. */
  isolation?: TransactionIsolation;
  attempts?: number;
  pause?: (ms: number) => Promise<void>;
  random?: () => number;
}

// After an error answer to COMMIT the transaction is over; only a rollback
// class says none of it committed.
function commitRolledBack(error: unknown): boolean {
  const state = sqlState(error);
  return state !== undefined && state !== "40003" && (state.startsWith("40") || state.startsWith("23"));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function attemptTransaction<T>(
  pool: TransactionPool,
  work: (client: PoolClient) => Promise<T>,
  isolation: TransactionIsolation,
  operation: string,
): Promise<T> {
  const client = await pool.connect();
  // A connection that could not roll back, or lost its COMMIT, is discarded
  // instead of being returned to the pool.
  let discard: Error | undefined;
  try {
    let result: T;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      result = await work(client);
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => { discard = asError(rollbackError); });
      throw error;
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      if (commitRolledBack(error)) throw error;
      discard = asError(error);
      throw new TransactionOutcomeUnknownError(operation, error);
    }
    return result;
  } finally {
    client.release(discard);
  }
}

/**
 * Runs `work` inside one database transaction, and runs the whole
 * transaction again, from a fresh BEGIN on a fresh connection, when Postgres
 * rolled it back as a serialization failure (40001) or a deadlock victim
 * (40P01). Every attempt repeats every read and check, so a retry decides on
 * what is committed by then; nothing an aborted attempt read survives it.
 * Use it only for work with no effect outside the database. Any other error,
 * and a transient one on the last attempt, is the caller's. A lost COMMIT is
 * never retried: it surfaces as TransactionOutcomeUnknownError.
 */
export async function runTransientTransaction<T>(
  pool: TransactionPool,
  work: (client: PoolClient) => Promise<T>,
  options: TransientTransactionOptions,
): Promise<T> {
  const attempts = options.attempts ?? TRANSACTION_ATTEMPTS;
  const isolation = options.isolation ?? "READ COMMITTED";
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptTransaction(pool, work, isolation, options.operation);
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt >= attempts) throw error;
      const delayMs = transactionRetryDelayMs(attempt, options.random);
      logger.warn("database transaction retried", {
        operation: options.operation,
        sqlstate: sqlState(error),
        attempt,
        attempts,
        delayMs,
      });
      await pause(delayMs);
    }
  }
}
