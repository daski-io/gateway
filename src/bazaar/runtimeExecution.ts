import { withBazaarLease } from "./lease.js";
import type { BazaarRuntimeExecutionStore } from "./runtimeExecutionStore.js";

export async function withBazaarRuntimeExecution<T, U>(input: {
  store: BazaarRuntimeExecutionStore;
  signal?: AbortSignal;
  action: (signal: AbortSignal) => Promise<T>;
  unavailable: () => U;
}): Promise<T | U> {
  if (input.signal?.aborted) return input.unavailable();
  const execution = await input.store.begin();
  if (!execution) return input.unavailable();
  if (input.signal?.aborted) {
    await input.store.complete(execution.executionId, execution.leaseToken);
    return input.unavailable();
  }
  return withBazaarLease({
    store: input.store,
    orderRecordId: execution.executionId,
    leaseToken: execution.leaseToken,
    action: async (lease) => {
      const result = await input.action(lease.signal);
      if (!(await input.store.complete(
        execution.executionId,
        execution.leaseToken,
      ))) return input.unavailable();
      lease.complete();
      return result;
    },
    onOwnershipLost: input.unavailable,
    signal: input.signal,
  });
}
