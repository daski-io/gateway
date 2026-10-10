import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import type { FacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";

const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const splitter = "0x2222222222222222222222222222222222222222";
const covering = {
  blockNumber: 105n, blockHash: hash("b"), transactionIndex: 0, logIndex: 2,
  transactionHash: hash("e"), releaseSequence: 9n,
};
type Reference = typeof covering;
type Fence = <T>(work: () => Promise<T>) => Promise<T>;
interface World { final: Reference | null; mined: Reference | null; refuse?: boolean; head?: bigint }

/**
 * One order waiting for the release that covers its deposit: `world.final`
 * is the finalized covering release, `world.mined` one mined but not final.
 * `whileLocking` changes the chain while this order waits for the nonce lock.
 */
function harness(world: World, whileLocking: () => void = () => undefined) {
  const events: string[] = [];
  const nonceLock: FacilitatorNonceLock = {
    async run<T>(work: () => Promise<T>): Promise<T> {
      whileLocking();
      events.push("lock");
      try { return await work(); } finally { events.push("unlock"); }
    },
  };
  const findCoveringRelease = vi.fn(async (_client: unknown, _args: unknown, finalOnly = true) =>
    finalOnly ? world.final : world.mined ?? world.final);
  const evidence = new StandardChainEvidence({
    evidenceRpcUrls: ["https://rpc-a.example"],
    releasePrivateKey: `0x${"11".repeat(32)}`,
    finalityConfirmations: 12,
  } as unknown as StandardRailConfig, baseSepolia, nonceLock);
  const writeContract = vi.fn(async (): Promise<Hex> => {
    events.push("send");
    world.mined = covering;
    // Another order's release emptied the splitter first: this one reverts.
    if (world.refuse) throw new Error("execution reverted: BalanceBelowMinimum");
    return hash("e");
  });
  Object.assign(evidence as unknown as Record<string, unknown>, {
    wallet: { writeContract },
    clients: [{
      host: "rpc-a.example",
      client: {
        getTransactionReceipt: vi.fn(async () => {
          events.push("included");
          return { status: "success", blockNumber: 105n };
        }),
        getBlockNumber: vi.fn(async () => world.head ?? 200n),
      },
    }],
    findCoveringRelease,
  });
  const fence = vi.fn(async <T,>(work: () => Promise<T>) => {
    events.push("fence");
    try { return await work(); } finally { events.push("unfence"); }
  });
  const wait = () => (evidence as unknown as {
    coveringRelease(args: unknown, splitter: string, fence: Fence): Promise<Reference>;
  }).coveringRelease({}, splitter, fence as unknown as Fence);
  return { events, fence, writeContract, wait, findCoveringRelease };
}

/** Advances the poll timer until `promise` settles; `afterFirstPoll` changes the chain once. */
async function settle<T>(promise: Promise<T>, afterFirstPoll: () => void = () => undefined): Promise<T> {
  let state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(value => { state = { done: true, value }; }, error => { state = { done: true, error }; });
  for (let poll = 0; poll < 200 && !state.done; poll += 1) {
    await vi.advanceTimersByTimeAsync(2_000);
    if (poll === 0) afterFirstPoll();
  }
  if (!state.done) throw new Error("the release wait never settled");
  if (state.error) throw state.error;
  return state.value as T;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("concurrent orders of one listing share the release that covers their deposits", () => {
  it("proves an already finalized covering release without submitting or fencing anything", async () => {
    const h = harness({ final: covering, mined: covering });
    await expect(h.wait()).resolves.toEqual(covering);
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.fence).not.toHaveBeenCalled();
  });

  it("waits for another order's release that is mined but not final instead of submitting a second", async () => {
    const world: World = { final: null, mined: covering };
    const h = harness(world);
    await expect(settle(h.wait(), () => { world.final = covering; })).resolves.toEqual(covering);
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.fence).not.toHaveBeenCalled();
  });

  it("submits one release inside the fence, holds the nonce lock only until inclusion, and waits for finality outside both", async () => {
    const world: World = { final: null, mined: null };
    const h = harness(world);
    await expect(settle(h.wait(), () => { world.final = covering; })).resolves.toEqual(covering);
    expect(h.writeContract).toHaveBeenCalledOnce();
    expect(h.events).toEqual(["fence", "lock", "send", "included", "unlock", "unfence"]);
  });

  it("reads only the head until the mined release can be final, then looks it up once", async () => {
    // Twelve confirmations: block 105 is final at head 116.
    const world: World = { final: null, mined: covering, head: 106n };
    const h = harness(world);
    let state: { done: boolean; value?: Reference } = { done: false };
    const waiting = h.wait().then(value => { state = { done: true, value }; });
    for (let poll = 0; poll < 5; poll += 1) await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(false);
    expect(h.findCoveringRelease).toHaveBeenCalledTimes(2);
    world.head = 116n;
    world.final = covering;
    for (let poll = 0; poll < 3 && !state.done; poll += 1) await vi.advanceTimersByTimeAsync(2_000);
    await waiting;
    expect(state.value).toEqual(covering);
    expect(h.findCoveringRelease).toHaveBeenCalledTimes(3);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it("looks again under the lock, so a release mined while it waited is never duplicated", async () => {
    const world: World = { final: null, mined: null };
    const h = harness(world, () => { world.mined = covering; });
    await expect(settle(h.wait(), () => { world.final = covering; })).resolves.toEqual(covering);
    expect(h.writeContract).not.toHaveBeenCalled();
    expect(h.events).toEqual(["fence", "lock", "unlock", "unfence"]);
  });

  it("accepts a submission that reverts because another order's release emptied the splitter", async () => {
    const world: World = { final: null, mined: null, refuse: true };
    const h = harness(world);
    await expect(settle(h.wait(), () => { world.final = covering; })).resolves.toEqual(covering);
    expect(h.writeContract).toHaveBeenCalledOnce();
  });

  it("fails when its submission fails and no release covers the deposit", async () => {
    const h = harness({ final: null, mined: null });
    h.writeContract.mockImplementation(async () => { throw new Error("rpc refused the transaction"); });
    await expect(settle(h.wait())).rejects.toThrow("rpc refused the transaction");
  });
});
