import type { Transport } from "viem";

/**
 * Proof reads, served ahead of every ordinary read at their endpoint: payment
 * proofs first, then the registration proofs that activate paid listings.
 */
export type RpcProofPriority = "payment" | "registration";

interface RpcPacing {
  scope: string;
  maxPerMinute?: number;
  maxWaitMs?: number;
  /**
   * A proof client. Its reads go ahead of every ordinary read at the endpoint
   * and keep their place until served; only an explicit caller deadline or an
   * abort ends their wait. Without it the client's reads are ordinary.
   */
  priority?: RpcProofPriority;
  concurrency?: number;
  /** Reads this client presents to the endpoint queue at once: 1 by default, at most its lanes. */
  presented?: number;
  /** Requests this client holds before dispatch; one more is refused at once. */
  maxQueued?: number;
}
interface SchedulingOptions { signal?: AbortSignal; deadline?: number }
/** Endpoint precedence levels, highest first. */
const PAYMENT = 0, REGISTRATION = 1, ORDINARY = 2;
interface Waiter {
  /** The caller's explicit deadline, or Infinity. */
  deadline: number;
  /**
   * The end of an ordinary read's bounded wait (Infinity for proof reads).
   * Each slot a higher level takes while the read waits moves it one slot
   * later: the read yielded that slot, so it does not count against the wait.
   */
  budget: number;
  spacing: number;
  queue: Waiter[];
  finish: (error?: Error) => void;
}
interface Budget {
  nextAt: number;
  /** Waiting reads by level: payment proofs, registration proofs, ordinary reads. */
  levels: [Waiter[], Waiter[], Waiter[]];
  /**
   * owes[level]: that level took the last slot it competed for while a read
   * of a lower level waited, so the next slot it competes for goes lower.
   */
  owes: [boolean, boolean, boolean];
  timer?: ReturnType<typeof setTimeout>;
}
const endpointBudgets = new Map<string, Budget>();
const MAX_QUEUED_REQUESTS = 64;
const DEFAULT_MAX_WAIT_MS = 2_000;

export class RpcQueueUnavailableError extends Error {
  constructor() { super("RPC read queue is full or its wait deadline expired"); this.name = "RpcQueueUnavailableError"; }
}

const expiry = (waiter: Waiter) => Math.min(waiter.deadline, waiter.budget);

// The level the next slot goes to. The highest level with a waiting read is
// served, unless it took the last slot it competed for while a lower level
// waited: then the slot goes to the levels below, by the same rule. So while
// payment proofs wait, at most one other read is dispatched before the next
// of them (G5-H1), and each lower level that waits gets at least every
// fourth slot. With every level backlogged, payment proofs get half the
// endpoint and registration proofs and ordinary reads a quarter each; a
// level with nothing waiting leaves its share to the others.
function nextLevel(budget: Budget): number | undefined {
  for (let level = PAYMENT; level <= ORDINARY; level++) {
    if (!budget.levels[level]!.length) continue;
    if (budget.owes[level] && budget.levels.some((queue, lower) => lower > level && queue.length > 0)) continue;
    return level;
  }
  return undefined;
}

// Only dispatched reads consume a slot. Removing a cancelled waiter cannot
// leave a reservation behind or delay a later payment/settlement read.
function pump(budget: Budget): void {
  if (budget.timer) clearTimeout(budget.timer);
  budget.timer = undefined;
  for (;;) {
    const now = Date.now();
    for (const waiter of budget.levels.flat())
      if (now > expiry(waiter)) waiter.finish(new RpcQueueUnavailableError());
    const level = nextLevel(budget);
    if (level === undefined) { budget.owes = [false, false, false]; return; }
    if (budget.nextAt > now) {
      let wake = budget.nextAt;
      for (const waiter of budget.levels.flat()) wake = Math.min(wake, expiry(waiter) + 1);
      budget.timer = setTimeout(() => pump(budget), Math.max(1, wake - now));
      return;
    }
    const waiter = budget.levels[level]![0]!;
    const lower = budget.levels.slice(level + 1).flat();
    // The levels above had nothing waiting or were owing this slot, which
    // settles their debt; this level owes the next one when a lower one waits.
    for (let above = PAYMENT; above < level; above++) budget.owes[above] = false;
    budget.owes[level] = lower.length > 0;
    for (const yielded of lower) yielded.budget += waiter.spacing;
    budget.nextAt = now + waiter.spacing;
    waiter.finish();
  }
}
function paced(pacing: RpcPacing, level: number, deadline: number, waitBudget: number, signal?: AbortSignal): Promise<void> {
  let budget = endpointBudgets.get(pacing.scope);
  if (!budget) endpointBudgets.set(pacing.scope, budget = { nextAt: 0, levels: [[], [], []], owes: [false, false, false] });
  const queue = budget.levels[level]!;
  if (queue.length >= MAX_QUEUED_REQUESTS || signal?.aborted) return Promise.reject(new RpcQueueUnavailableError());
  if (pacing.maxWaitMs === 0 && (budget.levels.some(waiting => waiting.length > 0) || budget.nextAt > Date.now()))
    return Promise.reject(new RpcQueueUnavailableError());
  const endpoint = budget;
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => { waiter.finish(new RpcQueueUnavailableError()); pump(endpoint); };
    const waiter: Waiter = { deadline, budget: waitBudget, spacing: Math.ceil(60_000 / pacing.maxPerMinute!), queue,
      finish(error) {
        if (done) return;
        done = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      } };
    queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    pump(endpoint);
  });
}

/**
 * Keep a client's reads ordered and paced with every other client of the
 * same endpoint. A client presents at most `presented` reads (one by default)
 * to the endpoint queue at once, whatever its parallel lanes, oldest
 * operation first, so parallel lanes overlap only wire latency and a client
 * can never crowd out the others. A proof read (`priority`) keeps its place
 * at the endpoint until it is served; an explicit caller deadline or abort
 * still ends it. An ordinary read waits at most maxWaitMs (two seconds by
 * default) from the moment its client presents it; slots that proof reads
 * take meanwhile do not count against that wait, so a proof backlog delays
 * ordinary reads but cannot expire them. A batch never exhausts its wait
 * behind its own earlier reads, and an explicit caller deadline covers the
 * entire queue. Ordinary clients hold at most 64 requests (`maxQueued`
 * fewer) and refuse more at once; proof clients are not bounded.
 * Optional quote reads (maxWaitMs:0) never reserve future capacity.
 */
export function orderedRpcTransport(transport: Transport, pacing?: RpcPacing): Transport {
  if (pacing?.maxPerMinute !== undefined &&
      (!Number.isSafeInteger(pacing.maxPerMinute) || pacing.maxPerMinute < 1)) throw new Error("Invalid RPC read budget");
  if (pacing?.maxWaitMs !== undefined &&
      (!Number.isSafeInteger(pacing.maxWaitMs) || pacing.maxWaitMs < 0)) throw new Error("Invalid RPC queue wait");
  if (pacing?.maxQueued !== undefined &&
      (!Number.isSafeInteger(pacing.maxQueued) || pacing.maxQueued < 1 || pacing.maxQueued > MAX_QUEUED_REQUESTS))
    throw new Error("Invalid RPC queue bound");
  if (pacing?.priority !== undefined && pacing.priority !== "payment" && pacing.priority !== "registration")
    throw new Error("Invalid RPC read priority");
  const level = pacing?.priority === "payment" ? PAYMENT : pacing?.priority === "registration" ? REGISTRATION : ORDINARY;
  const proof = level !== ORDINARY;
  return parameters => {
    const target = transport(parameters);
    const concurrency = pacing?.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid RPC concurrency");
    const presented = pacing?.presented ?? 1;
    if (!Number.isSafeInteger(presented) || presented < 1 || presented > concurrency) throw new Error("Invalid RPC presentation");
    const tails: Promise<void>[] = Array.from({ length: concurrency }, () => Promise.resolve());
    const pending: number[] = Array.from({ length: concurrency }, () => 0);
    const maxQueued = pacing?.maxQueued ?? (proof ? Infinity : MAX_QUEUED_REQUESTS);
    let queued = 0;
    // The client's reads take turns at the endpoint queue, at most
    // `presented` at a time, oldest operation first: reads sharing an abort
    // signal are one operation (a payer verification's code lookup and call),
    // so a verification's call waiting for a turn goes before the code
    // lookups of verifications that started after it.
    const turns: Array<{ order: number; start: () => void }> = [];
    const operations = new WeakMap<AbortSignal, number>();
    let sequence = 0, turnsHeld = 0;
    const nextTurn = () => {
      while (turnsHeld < presented && turns.length) {
        turnsHeld++;
        turns.shift()!.start();
      }
    };
    const request = ((...args: Parameters<typeof target.request>) => {
      const options = args[1] as SchedulingOptions | undefined;
      const signal = options?.signal, deadline = options?.deadline ?? Infinity;
      const maxWaitMs = pacing?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
      if (signal?.aborted || Date.now() > deadline || queued >= maxQueued ||
          (maxWaitMs === 0 && queued > 0)) return Promise.reject(new RpcQueueUnavailableError());
      queued++;
      let order = ++sequence;
      if (signal) {
        const operation = operations.get(signal);
        if (operation === undefined) operations.set(signal, order); else order = operation;
      }
      let waiting = true, counted = true;
      // A cancelled or expired read stops counting against maxQueued at once,
      // not when its lane and pacing turn come round to discard it.
      const leaveQueue = () => { if (counted) { counted = false; queued--; } };
      let rejectWait!: (reason: unknown) => void;
      const canceled = new Promise<never>((_, reject) => { rejectWait = reject; });
      const abort = () => { if (waiting) { waiting = false; leaveQueue(); rejectWait(new RpcQueueUnavailableError()); } };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = Number.isFinite(deadline) ? setTimeout(abort, Math.max(0, deadline - Date.now())) : undefined;
      // The least-loaded lane: a read never waits behind a busy lane while another is idle.
      const lane = pending.indexOf(Math.min(...pending));
      pending[lane] = pending[lane]! + 1;
      const expired = () => !waiting || signal?.aborted || Date.now() > deadline;
      const work = tails[lane]!.then(async () => {
        try {
          if (expired()) throw new RpcQueueUnavailableError();
          if (pacing?.maxPerMinute !== undefined) {
            await new Promise<void>((resolve, reject) => {
              const start = () => {
                const done = (error?: unknown) => { turnsHeld--; nextTurn(); if (error) reject(error); else resolve(); };
                // Presented now: an ordinary read's bounded wait starts here.
                if (expired()) done(new RpcQueueUnavailableError());
                else paced(pacing, level, deadline, proof ? Infinity : Date.now() + maxWaitMs, signal).then(() => done(), done);
              };
              const at = turns.findIndex(turn => turn.order > order);
              turns.splice(at < 0 ? turns.length : at, 0, { order, start });
              nextTurn();
            });
          }
          if (expired()) throw new RpcQueueUnavailableError();
          waiting = false;
          leaveQueue();
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          return target.request(...args);
        } finally {
          leaveQueue();
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      });
      tails[lane] = work.then(() => undefined, () => undefined).finally(() => { pending[lane] = pending[lane]! - 1; });
      return Promise.race([work, canceled]);
    }) as typeof target.request;
    return { ...target, request };
  };
}
