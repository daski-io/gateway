import { createPublicClient, parseAbi } from "viem";
import { base } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyRpcFailure } from "../src/rpc/classification.js";
import {
  RPC_LONG_READ_TIMEOUT_MS,
  RPC_SHORT_READ_TIMEOUT_MS,
  rpcReadTimeoutMs,
  rpcReadTransport,
} from "../src/rpc/readTransport.js";
import { stubRpcFetch } from "./helpers/rpcStub.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SHORT = RPC_SHORT_READ_TIMEOUT_MS;
const LONG = RPC_LONG_READ_TIMEOUT_MS;

afterEach(() => { vi.useRealTimers(); });

describe("per-method RPC read timeouts", () => {
  it.each([
    ["eth_blockNumber", [], SHORT],
    ["eth_getBlockByNumber", ["finalized", false], SHORT],
    ["eth_getTransactionReceipt", [`0x${"11".repeat(32)}`], SHORT],
    ["eth_getTransactionCount", [ADDRESS, "pending"], SHORT],
    ["eth_getBalance", [ADDRESS, "latest"], SHORT],
    ["eth_getCode", [ADDRESS, "latest"], SHORT],
    ["eth_call", [{ to: ADDRESS, data: "0x70a08231" }, "latest"], SHORT],
    ["eth_call", [{ to: ADDRESS, data: "0x70a08231" }], SHORT],
    ["eth_call", [{ to: ADDRESS, data: "0x70a08231" }, "0x64"], LONG],
    ["eth_call", [{ to: ADDRESS, data: "0x70a08231" }, { blockHash: `0x${"22".repeat(32)}` }], LONG],
    ["eth_call", [{ to: MULTICALL3, data: "0x82ad56cb00" }, "latest"], LONG],
    ["eth_getCode", [ADDRESS, "0x64"], LONG],
    ["eth_getStorageAt", [ADDRESS, "0x0", "0x64"], LONG],
    ["eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }], LONG],
  ] as const)("gives %s %j a %i ms timeout", (method, params, expected) => {
    expect(rpcReadTimeoutMs(method, params)).toBe(expected);
  });

  it("times a head read out at five seconds and lets eth_getLogs run to fifteen", async () => {
    vi.useFakeTimers();
    const fetchFn = stubRpcFetch(() => "hang");
    const client = createPublicClient({ chain: base, transport: rpcReadTransport("https://rpc.example.test/", { fetchFn }) });
    const head = client.getBlockNumber().then(() => "answered", (error: unknown) => error);
    const logs = client.getLogs({ fromBlock: 1n, toBlock: 2n }).then(() => "answered", (error: unknown) => error);
    let logsSettled = false;
    void logs.then(() => { logsSettled = true; });

    await vi.advanceTimersByTimeAsync(SHORT);
    expect(classifyRpcFailure(await head)).toMatchObject({ reason: "timeout", method: "eth_blockNumber" });
    expect(logsSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(LONG - SHORT);
    expect(classifyRpcFailure(await logs)).toMatchObject({ reason: "timeout", method: "eth_getLogs" });
  });

  it("keeps viem's own retries off: one request per failed read", async () => {
    const fetchFn = stubRpcFetch(() => ({ error: { code: -32603, message: "Internal error" } }));
    const client = createPublicClient({ chain: base, transport: rpcReadTransport("https://rpc.example.test/", { fetchFn }) });
    const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    await expect(client.readContract({ address: ADDRESS, abi, functionName: "balanceOf", args: [ADDRESS] }))
      .rejects.toThrow();
    expect(fetchFn.calls.map((call) => call.method)).toEqual(["eth_call"]);
  });
});
