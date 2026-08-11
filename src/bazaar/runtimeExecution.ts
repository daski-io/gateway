import { withBazaarLease } from "./lease.js";
import type { BazaarRuntimeExecutionStore } from "./runtimeExecutionStore.js";

export async function withBazaarRuntimeExecution<T, U>(input: {
  store: BazaarRuntimeExecutionStore;
  signal?: AbortSignal;
  action: (signal: AbortSignal) => Promise<T>;
  publish: (value: T | U) => Promise<void> | void;
  unavailable: () => U;
}): Promise<void> {
  const publishUnavailable = () => input.publish(input.unavailable());
  if (input.signal?.aborted) {
    await publishUnavailable();
    return;
  }
  const execution = await input.store.begin();
  if (!execution) {
    await publishUnavailable();
    return;
  }
  if (input.signal?.aborted) {
    await input.store.complete(execution.executionId, execution.leaseToken);
    await publishUnavailable();
    return;
  }
  let published = false;
  await withBazaarLease({
    store: input.store,
    orderRecordId: execution.executionId,
    leaseToken: execution.leaseToken,
    action: async (lease) => {
      const result = await input.action(lease.signal);
      lease.assertOwned();
      let renewed = false;
      try {
        renewed = await input.store.renewLease(
          execution.executionId,
          execution.leaseToken,
        );
      } catch {
        lease.loseOwnership();
        return;
      }
      if (!renewed) {
        lease.loseOwnership();
        return;
      }
      lease.assertOwned();
      published = true;
      await input.publish(result);
      if (await input.store.complete(
        execution.executionId,
        execution.leaseToken,
      )) lease.complete();
    },
    onOwnershipLost: async () => {
      if (!published) await publishUnavailable();
    },
    signal: input.signal,
  });
}
