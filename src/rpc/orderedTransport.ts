import type { Transport } from "viem";

const endpointBudgets = new Map<string, { nextAt: number }>();

export function orderedRpcTransport(transport: Transport, pacing?: { scope: string; maxPerMinute?: number }): Transport {
  return (parameters) => {
    const target = transport(parameters);
    let tail: Promise<void> = Promise.resolve();
    const request = ((...args: Parameters<typeof target.request>) => {
      const result = tail.then(async () => {
        const maximum = pacing?.maxPerMinute;
        if (pacing && maximum !== undefined) {
          if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid RPC read budget");
          const budget = endpointBudgets.get(pacing.scope) ?? { nextAt: 0 };
          const now = Date.now(), at = Math.max(now, budget.nextAt);
          budget.nextAt = at + Math.ceil(60_000 / maximum);
          endpointBudgets.set(pacing.scope, budget);
          if (at > now) await new Promise(resolve => setTimeout(resolve, at - now));
        }
        return target.request(...args);
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }) as typeof target.request;
    return { ...target, request };
  };
}
