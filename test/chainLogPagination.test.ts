import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { describe, expect, it } from "vitest";
import { rpcReadTransport } from "../src/rpc/readTransport.js";
import { loadLogsPaged, loadNewestLogs } from "../src/standardRail/chainLogPagination.js";
import { stubRpcFetch, type StubbedRpcReply } from "./helpers/rpcStub.js";

/** A real viem client whose eth_getLogs answers `reply` for ranges wider than `limit` blocks. */
function logsClient(limit: bigint, reply: StubbedRpcReply) {
  const fetchFn = stubRpcFetch(({ params }) => {
    const [filter] = params as [{ fromBlock: string; toBlock: string }];
    const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
    return span > limit ? reply : { result: [] };
  });
  const client = createPublicClient({ chain: base, transport: rpcReadTransport("https://rpc.example.test/", { fetchFn }) });
  return { fetchFn, load: (fromBlock: bigint, toBlock: bigint) => client.getLogs({ fromBlock, toBlock }) };
}

describe("loadLogsPaged", () => {
  it("does not treat cumulative history as a correctness limit", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 20_001n,
      maximumPageEvents: 2,
      load: async (fromBlock, toBlock) => [{ fromBlock, toBlock }],
    });

    expect(logs).toHaveLength(3);
  });

  it("subdivides dense block ranges without rejecting their events", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 4n,
      maximumPageEvents: 2,
      load: async (fromBlock, toBlock) => {
        const values = [];
        for (let block = fromBlock; block <= toBlock; block += 1n) values.push(block);
        return values;
      },
    });

    expect(logs).toEqual([1n, 2n, 3n, 4n]);
  });

  it("accepts a single block even when it exceeds the page target", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 7n,
      toBlock: 7n,
      maximumPageEvents: 2,
      load: async () => [1, 2, 3],
    });

    expect(logs).toEqual([1, 2, 3]);
  });

  it("splits an exact-threshold response that may have been truncated", async () => {
    const logs = await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 4n,
      maximumPageEvents: 2,
      load: async (fromBlock, toBlock) => {
        const values = [];
        for (let block = fromBlock; block <= toBlock; block += 1n) values.push(block);
        return values.slice(0, 2);
      },
    });

    expect(logs).toEqual([1n, 2n, 3n, 4n]);
  });

  it("bisects provider range errors until each request is accepted", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const logs = await loadLogsPaged({
      fromBlock: 1n,
      toBlock: 8n,
      maximumPageEvents: 10,
      load: async (fromBlock, toBlock) => {
        calls.push([fromBlock, toBlock]);
        if (toBlock - fromBlock + 1n > 2n) throw new Error("RPC range limit");
        return Array.from(
          { length: Number(toBlock - fromBlock + 1n) },
          (_, index) => fromBlock + BigInt(index),
        );
      },
    });

    expect(logs).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    expect(calls).toContainEqual([1n, 8n]);
  });

  it.each([
    ["Infura's result limit", { error: {
      code: -32005, message: "query returned more than 10000 results. Try with this block range [0x1, 0x400].",
    } }],
    ["a response size limit", { error: {
      code: -32602, message: "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range",
    } }],
    ["a block range limit", { error: { code: -32000, message: "block range too large" } }],
  ] as const)("bisects %s from a real node answer", async (_label, reply) => {
    const { fetchFn, load } = logsClient(1_000n, reply);
    await expect(loadLogsPaged({ fromBlock: 1n, toBlock: 4_000n, maximumPageEvents: 10, load })).resolves.toEqual([]);
    expect(fetchFn.calls.length).toBeGreaterThan(1);
  });

  it.each([
    ["an internal error", { error: { code: -32603, message: "Internal error" } }],
    ["a rate limit", { error: { code: -32005, message: "Too Many Requests" } }],
    ["an HTTP 502", new Response("Bad Gateway", { status: 502 })],
  ] as const)("does not split a range on %s: one request, then the failover", async (_label, reply) => {
    const { fetchFn, load } = logsClient(0n, reply);
    await expect(loadLogsPaged({ fromBlock: 1n, toBlock: 4_000n, maximumPageEvents: 10, load })).rejects.toThrow();
    expect(fetchFn.calls).toHaveLength(1);
  });

  it("propagates a provider error for a dense single block", async () => {
    await expect(loadLogsPaged({
      fromBlock: 9n,
      toBlock: 9n,
      maximumPageEvents: 2,
      load: async () => { throw new Error("single block unavailable"); },
    })).rejects.toThrow("single block unavailable");
  });

  it.each([0, -1, Number.NaN, 1.5])("rejects invalid page target %s", async (limit) => {
    await expect(loadLogsPaged({
      fromBlock: 1n,
      toBlock: 1n,
      maximumPageEvents: limit,
      load: async () => [],
    })).rejects.toThrow(/positive safe integer/);
  });

  it("produces the same ordered result on repeated stateless runs", async () => {
    const run = () => loadLogsPaged({
      fromBlock: 1n,
      toBlock: 6n,
      maximumPageEvents: 2,
      load: async (fromBlock, toBlock) => {
        const result = [];
        for (let block = fromBlock; block <= toBlock; block += 1n) result.push(block);
        return result;
      },
    });

    expect(await run()).toEqual(await run());
  });
});

describe("loadNewestLogs", () => {
  const windows = (calls: Array<[bigint, bigint]>) => calls.map(([from, to]) => `${from}-${to}`);
  const history = (events: bigint[], calls: Array<[bigint, bigint]>) => async (fromBlock: bigint, toBlock: bigint) => {
    calls.push([fromBlock, toBlock]);
    return events.filter(block => block >= fromBlock && block <= toBlock);
  };

  it("reads only the newest window when the event is recent", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const found = await loadNewestLogs({
      fromBlock: 1n, toBlock: 1_000_000n, maximumPageEvents: 1000,
      load: history([12n, 995_000n], calls), matches: () => true,
    });
    expect(found).toEqual([995_000n]);
    expect(windows(calls)).toEqual(["990001-1000000"]);
  });

  it("walks down window by window to an older event and never below the range", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const found = await loadNewestLogs({
      fromBlock: 5n, toBlock: 30_000n, maximumPageEvents: 1000,
      load: history([7n, 25_000n], calls), matches: block => block < 20_000n,
    });
    expect(found).toEqual([7n]);
    expect(windows(calls)).toEqual(["20001-30000", "10001-20000", "5-10000"]);
  });

  it("returns every match in the window it stops at, and nothing when the range has none", async () => {
    const calls: Array<[bigint, bigint]> = [];
    expect(await loadNewestLogs({
      fromBlock: 1n, toBlock: 20_000n, maximumPageEvents: 1000,
      load: history([15_000n, 19_000n, 3n], calls), matches: () => true,
    })).toEqual([15_000n, 19_000n]);
    const empty: Array<[bigint, bigint]> = [];
    expect(await loadNewestLogs({
      fromBlock: 1n, toBlock: 20_000n, maximumPageEvents: 1000,
      load: history([], empty), matches: () => true,
    })).toEqual([]);
    expect(windows(empty)).toEqual(["10001-20000", "1-10000"]);
  });
});
