import { createPublicClient, encodeErrorResult, parseAbi } from "viem";
import { base } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import {
  classifyRpcFailure,
  isLogRangeLimitError,
  rpcNodeMessage,
} from "../src/rpc/classification.js";
import { RpcQueueUnavailableError } from "../src/rpc/orderedTransport.js";
import { rpcReadTransport } from "../src/rpc/readTransport.js";
import { isContractRevert } from "../src/marketplace/reader.js";
import { jsonRpcErrorResponse, stubRpcFetch, type StubbedRpcReply } from "./helpers/rpcStub.js";

const URL = "https://rpc.example.test/v3/test-key-0123";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const abi = parseAbi(["function balanceOf(address holder) view returns (uint256)", "error Error(string message)"]);

function client(reply: (method: string) => StubbedRpcReply) {
  const fetchFn = stubRpcFetch(({ method }) => reply(method));
  return createPublicClient({ chain: base, transport: rpcReadTransport(URL, { fetchFn }) });
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
}

const readBalance = (reply: (method: string) => StubbedRpcReply) =>
  rejection(client(reply).readContract({ address: ADDRESS, abi, functionName: "balanceOf", args: [ADDRESS] }));

describe("RPC failure classification from real viem errors", () => {
  it("fails over on a -32603 internal error and counts it, from any read", async () => {
    const balance = await rejection(client(() => ({ error: { code: -32603, message: "Internal error" } }))
      .getBalance({ address: ADDRESS }));
    expect(classifyRpcFailure(balance)).toMatchObject({
      kind: "failover", reason: "internal_error", counted: true, code: -32603, method: "eth_getBalance",
    });
    // viem files a -32603 on eth_call as a revert without data; it stays an outage.
    const call = await readBalance(() => ({ error: { code: -32603, message: "Internal error" } }));
    expect((call as Error).name).toBe("ContractFunctionExecutionError");
    expect(isContractRevert(call)).toBe(false);
    expect(classifyRpcFailure(call)).toMatchObject({ kind: "failover", reason: "internal_error", code: -32603, method: "eth_call" });
  });

  it("is terminal for a revert that returned data, and not for invalid params or a missing method", async () => {
    const data = encodeErrorResult({ abi, errorName: "Error", args: ["not registered"] });
    const reverted = await readBalance(() => ({ error: { code: 3, message: "execution reverted: not registered", data } }));
    expect(isContractRevert(reverted)).toBe(true);
    expect(classifyRpcFailure(reverted)).toMatchObject({ kind: "terminal", reason: "revert", counted: false });

    const invalid = await rejection(client(() => ({ error: { code: -32602, message: "invalid argument 0" } })).getBlockNumber());
    expect(classifyRpcFailure(invalid)).toMatchObject({ kind: "terminal", reason: "invalid_params", code: -32602 });
    const missing = await rejection(client(() => ({ error: { code: -32601, message: "the method does not exist" } })).getBlockNumber());
    expect(classifyRpcFailure(missing)).toMatchObject({ kind: "terminal", reason: "method_not_found", code: -32601 });

    // A dataless revert is a node's answer, not an outage, but it is not
    // terminal either: no endpoint health is charged for it.
    const dataless = await readBalance(() => ({ error: { code: 3, message: "execution reverted" } }));
    expect(classifyRpcFailure(dataless)).toMatchObject({ kind: "failover", counted: false });
  });

  it("fails over at once on an unknown block, HTTP 5xx and network failures", async () => {
    const lagging = await rejection(client(() => ({ error: { code: -32000, message: "header not found" } })).getBlockNumber());
    expect(classifyRpcFailure(lagging)).toMatchObject({ kind: "failover", reason: "unknown_block", counted: true, code: -32000 });

    const unavailable = await rejection(client(() => new Response("Service Unavailable", { status: 503 })).getBlockNumber());
    expect(classifyRpcFailure(unavailable)).toMatchObject({ kind: "failover", reason: "http_5xx", counted: true, code: 503 });

    const refused = await rejection(client(() => new TypeError("fetch failed")).getBlockNumber());
    expect(classifyRpcFailure(refused)).toMatchObject({ kind: "failover", reason: "network", counted: true });
  });

  it("backs off on a rate limit, honoring Retry-After or Infura's backoff_seconds", async () => {
    const header = await rejection(client(() => new Response("Too Many Requests", {
      status: 429, headers: { "retry-after": "3" },
    })).getBlockNumber());
    const fromHeader = classifyRpcFailure(header);
    expect(fromHeader).toMatchObject({ kind: "backoff", reason: "rate_limited", counted: true, code: 429 });
    expect(fromHeader.retryAfterMs).toBeGreaterThan(2_000);
    expect(fromHeader.retryAfterMs).toBeLessThanOrEqual(3_000);

    const infura = await rejection(client(() => jsonRpcErrorResponse(429, {
      code: -32005, message: "Too Many Requests", data: { backoff_seconds: 2 },
    })).getBlockNumber());
    expect(classifyRpcFailure(infura)).toMatchObject({
      kind: "backoff", reason: "rate_limited", code: -32005, retryAfterMs: 2_000,
    });
  });

  it("backs off on a timeout and records the method and latency", async () => {
    vi.useFakeTimers();
    try {
      const pending = rejection(client(() => "hang").getBlockNumber());
      await vi.advanceTimersByTimeAsync(5_000);
      const timeout = classifyRpcFailure(await pending);
      expect(timeout).toMatchObject({ kind: "backoff", reason: "timeout", counted: true, method: "eth_blockNumber" });
      expect(timeout.latencyMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never charges a local pacing refusal or an observation's own assertion to the endpoint", () => {
    expect(classifyRpcFailure(new RpcQueueUnavailableError())).toMatchObject({ kind: "local", reason: "queue", counted: false });
    const wrapped = new Error("call failed", { cause: new RpcQueueUnavailableError() });
    expect(classifyRpcFailure(wrapped)).toMatchObject({ kind: "local", counted: false });
    expect(classifyRpcFailure(new Error("Settlement transaction is not finalized"))).toMatchObject({
      kind: "unclassified", counted: false,
    });
    // A numeric code on an error that is not viem's is not a node's answer.
    expect(classifyRpcFailure(Object.assign(new Error("x"), { code: -32603 }))).toMatchObject({ kind: "unclassified" });
  });

  it("reads the node's own message, never viem's composed one with the URL and request body", async () => {
    const error = await rejection(client(() => ({ error: { code: -32603, message: "Internal error" } })).getBlockNumber());
    expect((error as Error).message).toContain("test-key-0123");
    expect(rpcNodeMessage(error)).toBe("Internal error");
  });
});

describe("eth_getLogs range limits", () => {
  const logs = (reply: StubbedRpcReply) => rejection(client(() => reply).getLogs({ fromBlock: 1n, toBlock: 20_000n }));

  it("recognizes range and result-count refusals from the node's answer", async () => {
    expect(isLogRangeLimitError(await logs({ error: {
      code: -32005, message: "query returned more than 10000 results. Try with this block range [0x1, 0x2710].",
    } }))).toBe(true);
    expect(isLogRangeLimitError(await logs({ error: {
      code: -32602, message: "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range",
    } }))).toBe(true);
    expect(isLogRangeLimitError(await logs({ error: { code: -32000, message: "block range too large" } }))).toBe(true);
  });

  it("does not mistake an outage or a rate limit for a range limit", async () => {
    expect(isLogRangeLimitError(await logs({ error: { code: -32603, message: "Internal error" } }))).toBe(false);
    expect(isLogRangeLimitError(await logs({ error: { code: -32005, message: "Too Many Requests" } }))).toBe(false);
    expect(isLogRangeLimitError(await logs(new Response("Bad Gateway", { status: 502 })))).toBe(false);
    const rangeError = await logs({ error: {
      code: -32005, message: "query returned more than 10000 results",
    } });
    expect(classifyRpcFailure(rangeError)).toMatchObject({ reason: "log_range_limit", counted: false });
  });

  it("reads range errors that are not viem's from their own message", () => {
    expect(isLogRangeLimitError(new Error("RPC range limit"))).toBe(true);
    expect(isLogRangeLimitError(new Error("socket hang up"))).toBe(false);
  });
});
