import { type Hex, type Log } from "viem";
import { describe, expect, it } from "vitest";
import { chainLogsHash } from "../src/standardRail/chainLogHash.js";

const address = "0x1111111111111111111111111111111111111111";
const topic = `0x${"33".repeat(32)}` as Hex;

describe("chain log hash", () => {
  it("canonically hashes mined logs with bigint block numbers", () => {
    const log: Log<bigint, number, false> = {
      address,
      blockHash: `0x${"66".repeat(32)}` as Hex,
      blockNumber: 123n,
      data: "0x" as Hex,
      logIndex: 2,
      removed: false,
      topics: [topic],
      transactionHash: `0x${"77".repeat(32)}` as Hex,
      transactionIndex: 1,
    };

    expect(chainLogsHash([log])).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chainLogsHash([log])).toBe(chainLogsHash([{ ...log }]));
  });
});
