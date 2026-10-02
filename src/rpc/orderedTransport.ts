import type { Transport } from "viem";

interface RpcPacing { scope: string; maxPerMinute?: number; maxWaitMs?: number }
interface SchedulingOptions { signal?: AbortSignal; deadline?: number }
interface Waiter { deadline: number; spacing: number; finish: (error?: Error) => void }
interface Budget { nextAt: number; queue: Waiter[]; timer?: ReturnType<typeof setTimeout> }
const endpointBudgets = new Map<string, Budget>();
const MAX_QUEUED_REQUESTS = 64;
const DEFAULT_MAX_WAIT_MS = 2_000;

export class RpcQueueUnavailableError extends Error {
  constructor() { super("RPC read queue is full or its wait deadline expired"); this.name = "RpcQueueUnavailableError"; }
}

// Only dispatched reads consume a slot. Removing a cancelled waiter cannot
// leave a reservation behind or delay a later payment/settlement read.
function pump(budget: Budget): void {
  if (budget.timer) clearTimeout(budget.timer);
  budget.timer = undefined;
  while (budget.queue.length) {
    const waiter = budget.queue[0]!, now = Date.now();
    if (now > waiter.deadline) { waiter.finish(new RpcQueueUnavailableError()); continue; }
    if (budget.nextAt <= now) {
      budget.nextAt = now + waiter.spacing;
      waiter.finish();
      continue;
    }
    budget.timer = setTimeout(() => pump(budget), Math.max(1, Math.min(budget.nextAt, waiter.deadline + 1) - now));
    return;
  }
}
function paced(pacing: RpcPacing, deadline: number, signal?: AbortSignal): Promise<void> {
  const budget = endpointBudgets.get(pacing.scope) ?? { nextAt: 0, queue: [] };
  endpointBudgets.set(pacing.scope, budget);
  if (budget.queue.length >= MAX_QUEUED_REQUESTS || signal?.aborted) return Promise.reject(new RpcQueueUnavailableError());
  if (pacing.maxWaitMs === 0 && (budget.queue.length || budget.nextAt > Date.now())) return Promise.reject(new RpcQueueUnavailableError());
  return new Promise((resolve, reject) => {
    let done = false;
    const abort = () => { waiter.finish(new RpcQueueUnavailableError()); pump(budget); };
    const waiter: Waiter = { deadline, spacing: Math.ceil(60_000 / pacing.maxPerMinute!),
      finish(error) {
        if (done) return;
        done = true;
        const index = budget.queue.indexOf(waiter);
        if (index >= 0) budget.queue.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      } };
    budget.queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    pump(budget);
  });
}

/**
 * Keep a client's reads ordered. The bounded endpoint wait starts when a read
 * reaches the head of that client's queue, so a required proof batch cannot
 * exhaust its own budget. An explicit caller deadline still covers the entire
 * queue. Optional quote reads (maxWaitMs:0) never reserve future capacity.
 */
export function orderedRpcTransport(transport: Transport, pacing?: RpcPacing): Transport {
  if (pacing?.maxPerMinute !== undefined &&
      (!Number.isSafeInteger(pacing.maxPerMinute) || pacing.maxPerMinute < 1)) throw new Error("Invalid RPC read budget");
  if (pacing?.maxWaitMs !== undefined &&
      (!Number.isSafeInteger(pacing.maxWaitMs) || pacing.maxWaitMs < 0)) throw new Error("Invalid RPC queue wait");
  return parameters => {
    const target = transport(parameters);
    let tail: Promise<void> = Promise.resolve(), queued = 0;
    const request = ((...args: Parameters<typeof target.request>) => {
      const options = args[1] as SchedulingOptions | undefined;
      const signal = options?.signal, deadline = options?.deadline ?? Infinity;
      const maxWaitMs = pacing?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
      if (signal?.aborted || Date.now() > deadline || queued >= MAX_QUEUED_REQUESTS ||
          (maxWaitMs === 0 && queued > 0)) return Promise.reject(new RpcQueueUnavailableError());
      queued++;
      let waiting = true;
      let rejectWait!: (reason: unknown) => void;
      const canceled = new Promise<never>((_, reject) => { rejectWait = reject; });
      const abort = () => { if (waiting) { waiting = false; rejectWait(new RpcQueueUnavailableError()); } };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = Number.isFinite(deadline) ? setTimeout(abort, Math.max(0, deadline - Date.now())) : undefined;
      const work = tail.then(async () => {
        try {
          if (!waiting || signal?.aborted || Date.now() > deadline) throw new RpcQueueUnavailableError();
          if (pacing?.maxPerMinute !== undefined)
            await paced(pacing, Math.min(deadline, Date.now() + maxWaitMs), signal);
          if (!waiting || signal?.aborted || Date.now() > deadline) throw new RpcQueueUnavailableError();
          waiting = false;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          return target.request(...args);
        } finally {
          queued--;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      });
      tail = work.then(() => undefined, () => undefined);
      return Promise.race([work, canceled]);
    }) as typeof target.request;
    return { ...target, request };
  };
}
