import { describe, expect, it, vi } from "vitest";
import type { ChainProjectionDescriptor } from "../src/chain/eventTypes.js";
import type {
  ChainStatusReader,
  ChainEventReader,
} from "../src/chain/reader.js";
import { ChainEventsIndexer } from "../src/indexer/chainEvents.js";
import { ReputationMirrorWorker } from "../src/reputation/worker.js";
import { withGracePeriod } from "../src/runtime/gracePeriod.js";
import type { Config } from "../src/config.js";
import type { Hex } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const descriptor: ChainProjectionDescriptor = {
  chainId: 8453,
  paymentRouterAddress: "0x0000000000000000000000000000000000000001",
  reputationStorageAddress: "0x0000000000000000000000000000000000000002",
  easAddress: "0x0000000000000000000000000000000000000003",
  confirmationSchemaUid: `0x${"11".repeat(32)}`,
  startBlock: 0n,
};

describe("graceful lifecycle", () => {
  it("waits for an active indexer page and is idempotent", async () => {
    const events = deferred<[]>();
    const pageStarted = deferred<void>();
    const applyPage = vi.fn(async () => {});
    const reader: ChainEventReader & ChainStatusReader = {
      getBlockNumber: async () => 1n,
      verifyDeploymentReadiness: async () => ({
        ready: true,
        failedCheck: null,
      }),
      getChainProjectionEvents: () => {
        pageStarted.resolve();
        return events.promise;
      },
    };
    const queries = {
      getOrAdoptChainProjection: async () => null,
      getChainProjectionState: async () => ({
        cursor: null,
        terminalFailure: null,
      }),
      tryWithChainProjectionLock: async (operation: () => Promise<void>) => {
        await operation();
        return { acquired: true, value: undefined };
      },
      recordChainProjectionTerminalFailure: async () => {},
      applyChainProjectionPage: applyPage,
    };
    const indexer = new ChainEventsIndexer(
      reader,
      queries as never,
      descriptor,
      { confirmationDepthBlocks: 0n },
    );
    const tick = indexer.tick();
    await pageStarted.promise;
    const firstDrain = indexer.stopAndDrain();
    const secondDrain = indexer.stopAndDrain();
    let drained = false;
    void firstDrain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    events.resolve([]);
    await Promise.all([tick, firstDrain, secondDrain]);
    expect(applyPage).toHaveBeenCalledOnce();
    await indexer.tick();
    expect(applyPage).toHaveBeenCalledOnce();
  });

  it("waits for an active reputation pass and starts no work after stop", async () => {
    const missing = deferred<[]>();
    const listMissing = vi.fn(() => missing.promise);
    const worker = new ReputationMirrorWorker({
      config: {
        chainMode: "live",
        reputationRegistryAddress:
          "0x0000000000000000000000000000000000000004" as Hex,
      } as Config,
      reader: {} as never,
      queries: {
        listMissingReputationMirrors: listMissing,
        claimReputationMirror: async () => null,
      } as never,
    });
    const tick = worker.tick();
    const drain = worker.stopAndDrain();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    missing.resolve([]);
    await Promise.all([tick, drain]);
    await worker.tick();
    expect(listMissing).toHaveBeenCalledOnce();
  });

  it("uses the explicit failure path when the grace period expires", async () => {
    vi.useFakeTimers();
    try {
      const guarded = withGracePeriod(new Promise<void>(() => {}), 25);
      const rejection = expect(guarded).rejects.toThrow(
        "shutdown exceeded 25ms grace period",
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
