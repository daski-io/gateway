import type { Transport } from "viem";

interface RpcPacing { scope: string; maxPerMinute?: number; maxWaitMs?: number }
interface SchedulingOptions { signal?: AbortSignal; deadline?: number }
const endpointBudgets = new Map<string, { nextAt: number }>();
const MAX_QUEUED_REQUESTS = 64;
const DEFAULT_MAX_WAIT_MS = 2_000;

export class RpcQueueUnavailableError extends Error {
  constructor() { super("RPC read queue is full or its wait deadline expired"); this.name = "RpcQueueUnavailableError"; }
}

/**
 * Preserve each client's wire order, but bound the entire wait from admission,
 * including time behind an in-flight request. Expired/aborted work never reaches
 * the wire. maxWaitMs: 0 is best-effort admission: it cannot reserve a future
 * endpoint slot (used by optional quote balance preflight).
 */
export function orderedRpcTransport(transport: Transport, pacing?: RpcPacing): Transport {
  if (pacing?.maxPerMinute !== undefined &&
      (!Number.isSafeInteger(pacing.maxPerMinute) || pacing.maxPerMinute < 1)) throw new Error("Invalid RPC read budget");
  if (pacing?.maxWaitMs !== undefined &&
      (!Number.isSafeInteger(pacing.maxWaitMs) || pacing.maxWaitMs < 0)) throw new Error("Invalid RPC queue wait");
  return (parameters) => {
    const target = transport(parameters);
    let tail: Promise<void> = Promise.resolve();
    let queued = 0;
    const request = ((...args: Parameters<typeof target.request>) => {
      const options = args[1] as SchedulingOptions | undefined;
      const signal = options?.signal;
      const maxWaitMs = pacing?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
      const deadline = Math.min(Date.now() + maxWaitMs, options?.deadline ?? Infinity);
      if (signal?.aborted) return Promise.reject(signal.reason ?? new RpcQueueUnavailableError());
      if (queued >= MAX_QUEUED_REQUESTS || (maxWaitMs === 0 && queued > 0)) return Promise.reject(new RpcQueueUnavailableError());
      queued++;
      let waiting = true;
      let rejectWait: (reason: unknown) => void;
      const canceled = new Promise<never>((_, reject) => { rejectWait = reject; });
      const abort = () => {
        if (waiting) { waiting = false; rejectWait(signal?.reason ?? new RpcQueueUnavailableError()); }
      };
      signal?.addEventListener("abort", abort, { once: true });
      // A zero-wait request is checked at the head in the current microtask.
      const timer = maxWaitMs > 0 ? setTimeout(abort, Math.max(0, deadline - Date.now())) : undefined;
      const work = tail.then(async () => {
        try {
          if (!waiting || signal?.aborted || Date.now() > deadline) throw new RpcQueueUnavailableError();
          const maximum = pacing?.maxPerMinute;
          if (pacing && maximum !== undefined) {
            const budget = endpointBudgets.get(pacing.scope) ?? { nextAt: 0 };
            const now = Date.now(), at = Math.max(now, budget.nextAt);
            if (at > deadline) throw new RpcQueueUnavailableError();
            budget.nextAt = at + Math.ceil(60_000 / maximum);
            endpointBudgets.set(pacing.scope, budget);
            if (at > now) await Promise.race([new Promise(resolve => setTimeout(resolve, at - now)), canceled]);
          }
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
