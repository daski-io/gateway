import { describe, expect, it } from "vitest";
import { loadLogsPaged } from "../src/standardRail/chainLogPagination.js";

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
