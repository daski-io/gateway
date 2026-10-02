import type { Transport } from "viem";

interface RpcPacing {
  scope: string;
  maxPerMinute?: number;
  maxWaitMs?: number;
  /** Payment and registration proof reads: served ahead of other reads at the endpoint. */
  required?: boolean;
  concurrency?: number;
  /** Requests this client holds before dispatch; one more is refused at once. */
  maxQueued?: number;
}
interface SchedulingOptions { signal?: AbortSignal; deadline?: number }
interface Waiter { deadline: number; spacing: number; queue: Waiter[]; finish: (error?: Error) => void }
interface Budget {
  nextAt: number;
  /** Waiting reads of `required` clients, served first. */
  required: Waiter[];
  /** Waiting reads of every other paced client. */
  other: Waiter[];
  /** The last dispatch passed over a waiting read of the other class. */
  owesOther: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const endpointBudgets = new Map<string, Budget>();
const MAX_QUEUED_REQUESTS = 64;
const DEFAULT_MAX_WAIT_MS = 2_000;

export class RpcQueueUnavailableError extends Error {
  constructor() { super("RPC read queue is full or its wait deadline expired"); this.name = "RpcQueueUnavailableError"; }
}

// Only dispatched reads consume a slot. Removing a cancelled waiter cannot
// leave a reservation behind or delay a later payment/settlement read.
//
// Required proof reads are served before every other read at the endpoint, so
// a payment proof never fails because other work queued ahead of it (G5-H1).
// While a required read was just served and another read is waiting, that read
// goes next: a backlog of required reads (concurrent proofs, or pre-payment
// screening, which reads through the same client) cannot starve the readers
// that keep the purchase fence, wallet queries and payer verification alive.
// A required read is therefore never more than one other read from dispatch.
function pump(budget: Budget): void {
  if (budget.timer) clearTimeout(budget.timer);
  budget.timer = undefined;
  for (;;) {
    const now = Date.now();
    for (const waiter of [...budget.required, ...budget.other])
      if (now > waiter.deadline) waiter.finish(new RpcQueueUnavailableError());
    const required = budget.required[0], other = budget.other[0];
    if (!required && !other) { budget.owesOther = false; return; }
    if (budget.nextAt > now) {
      let wake = budget.nextAt;
      for (const waiter of [...budget.required, ...budget.other]) wake = Math.min(wake, waiter.deadline + 1);
      budget.timer = setTimeout(() => pump(budget), Math.max(1, wake - now));
      return;
    }
    const waiter = required && !(other && budget.owesOther) ? required : other!;
    budget.owesOther = waiter === required && other !== undefined;
    budget.nextAt = now + waiter.spacing;
    waiter.finish();
  }
}
function paced(pacing: RpcPacing, deadline: number, signal?: AbortSignal): Promise<void> {
  let budget = endpointBudgets.get(pacing.scope);
  if (!budget) endpointBudgets.set(pacing.scope, budget = { nextAt: 0, required: [], other: [], owesOther: false });
  const queue = pacing.required ? budget.required : budget.other;
  if (queue.length >= MAX_QUEUED_REQUESTS || signal?.aborted) return Promise.reject(new RpcQueueUnavailableError());
  if (pacing.maxWaitMs === 0 && (budget.required.length || budget.other.length || budget.nextAt > Date.now()))
    return Promise.reject(new RpcQueueUnavailableError());
  const endpoint = budget;
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => { waiter.finish(new RpcQueueUnavailableError()); pump(endpoint); };
    const waiter: Waiter = { deadline, spacing: Math.ceil(60_000 / pacing.maxPerMinute!), queue,
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
 * Keep a client's reads ordered. The bounded endpoint wait starts when a read
 * reaches the head of that client's queue, so a required proof batch cannot
 * exhaust its own budget. An explicit caller deadline still covers the entire
 * queue. Required internal proofs retain their work under concurrent load and
 * are served first at the endpoint, waiting there until the caller's deadline
 * rather than the two-second wait; request-scoped clients retain the
 * admission cap. Independent signature reads may use bounded parallel lanes
 * without increasing endpoint rate: whatever its lanes, a client presents one
 * read at a time to the endpoint queue, so parallel lanes overlap only wire
 * latency and never crowd out other clients. `maxQueued` refuses at once what
 * the client could only queue behind its lanes.
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
  return parameters => {
    const target = transport(parameters);
    const concurrency = pacing?.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid RPC concurrency");
    const tails: Promise<void>[] = Array.from({ length: concurrency }, () => Promise.resolve());
    const pending: number[] = Array.from({ length: concurrency }, () => 0);
    const maxQueued = pacing?.maxQueued ?? (pacing?.required ? Infinity : MAX_QUEUED_REQUESTS);
    let queued = 0;
    // The client's reads take turns at the endpoint queue one at a time,
    // oldest operation first: reads sharing an abort signal are one operation
    // (a payer verification's code lookup and call), so under contention the
    // client finishes verifications it started instead of starting every
    // queued one and finishing none before their deadlines.
    const turns: Array<{ order: number; start: () => void }> = [];
    const operations = new WeakMap<AbortSignal, number>();
    let sequence = 0, turnHeld = false;
    const nextTurn = () => {
      if (turnHeld || !turns.length) return;
      turnHeld = true;
      turns.shift()!.start();
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
            // A required proof read keeps its place at the endpoint until the
            // caller's deadline; every other read waits at most maxWaitMs.
            const waitUntil = pacing.required ? deadline : Math.min(deadline, Date.now() + maxWaitMs);
            await new Promise<void>((resolve, reject) => {
              const start = () => {
                const done = (error?: unknown) => { turnHeld = false; nextTurn(); if (error) reject(error); else resolve(); };
                if (expired() || Date.now() > waitUntil) done(new RpcQueueUnavailableError());
                else paced(pacing, waitUntil, signal).then(() => done(), done);
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
