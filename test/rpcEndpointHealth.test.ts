import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeErrorResult,
  HttpRequestError,
  InternalRpcError,
  parseAbi,
  RpcRequestError,
} from "viem";
import { base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  RPC_BREAKER,
  resetRpcEndpointHealth,
  rpcEndpointHealthSnapshot,
} from "../src/rpc/endpointHealth.js";
import { resetRpcFailoverLogThrottle, withRpcFailover } from "../src/rpc/failover.js";
import { RpcQueueUnavailableError } from "../src/rpc/orderedTransport.js";
import { rpcReadTransport } from "../src/rpc/readTransport.js";
import { logger } from "../src/util/logger.js";
import { stubRpcFetch } from "./helpers/rpcStub.js";

const PRIMARY = { host: "primary.example", url: "https://primary.example/v3/test-key-0123", client: "primary" };
const FALLBACK = { host: "fallback.example", url: "https://fallback.example/", client: "fallback" };
const ENDPOINTS = [PRIMARY, FALLBACK] as const;
type Endpoint = (typeof ENDPOINTS)[number];

const internal = () => new InternalRpcError(new RpcRequestError({
  body: { method: "eth_call" }, error: { code: -32603, message: "Internal error" }, url: PRIMARY.url,
}));
const rateLimited = (seconds: string) => new HttpRequestError({
  body: { method: "eth_call" }, status: 429, url: PRIMARY.url, headers: new Headers({ "retry-after": seconds }),
});

function state(host: string) {
  return rpcEndpointHealthSnapshot().find((entry) => entry.host === host);
}

/** One observation whose primary attempt follows `primary` and whose fallback succeeds. */
function observeWith(primary: () => unknown, calls: string[], options: Parameters<typeof withRpcFailover>[2] = {}) {
  return withRpcFailover(ENDPOINTS, async ({ client }: Endpoint) => {
    calls.push(client);
    if (client === "primary") {
      const outcome = primary();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    return "fallback";
  }, { operation: "test.read", ...options });
}

let warn: MockInstance<(message: string, details?: unknown) => void>;
let info: MockInstance<(message: string, details?: unknown) => void>;

beforeEach(() => {
  resetRpcEndpointHealth();
  resetRpcFailoverLogThrottle();
  vi.useFakeTimers({ now: new Date("2026-10-19T12:00:00Z") });
  warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
  info.mockRestore();
});

describe("RPC endpoint circuit breaker", () => {
  it("fails over on -32603 at once, without retrying or waiting on the primary", async () => {
    const calls: string[] = [];
    await expect(observeWith(internal, calls)).resolves.toBe("fallback");
    expect(calls).toEqual(["primary", "fallback"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens after three consecutive failures, logs it, and skips the endpoint while open", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 3; index += 1) await observeWith(internal, calls);
    expect(state("primary.example")).toMatchObject({ state: "open", consecutiveFailures: 3, cooldownMs: 60_000 });
    expect(warn).toHaveBeenCalledWith("RPC endpoint circuit opened", expect.objectContaining({
      host: "primary.example", from: "closed", to: "open", failures: 3, cooldownMs: 60_000, reason: "internal_error",
    }));

    calls.length = 0;
    const onFallback = vi.fn();
    await expect(observeWith(() => "primary", calls, { onFallback })).resolves.toBe("fallback");
    expect(calls).toEqual(["fallback"]);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      primaryHost: "primary.example", selectedHost: "fallback.example", operation: "test.read", reason: "primary_open",
    }));
  });

  it("probes once after the cooldown and closes on success", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 3; index += 1) await observeWith(internal, calls);
    vi.advanceTimersByTime(RPC_BREAKER.cooldownMs);
    calls.length = 0;
    await expect(observeWith(() => "primary", calls)).resolves.toBe("primary");
    expect(calls).toEqual(["primary"]);
    expect(info).toHaveBeenCalledWith("RPC endpoint circuit half-open", expect.objectContaining({
      host: "primary.example", from: "open", to: "half-open",
    }));
    expect(info).toHaveBeenCalledWith("RPC endpoint circuit closed", expect.objectContaining({
      host: "primary.example", from: "half-open", to: "closed",
    }));
    expect(state("primary.example")).toMatchObject({ state: "closed", consecutiveFailures: 0, cooldownMs: 60_000 });
  });

  it("doubles the cooldown after each failed probe, up to ten minutes", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 3; index += 1) await observeWith(internal, calls);
    const cooldowns = [];
    for (let probe = 0; probe < 5; probe += 1) {
      vi.advanceTimersByTime(state("primary.example")!.cooldownMs);
      await observeWith(internal, calls);
      cooldowns.push(state("primary.example")!.cooldownMs);
    }
    expect(cooldowns).toEqual([120_000, 240_000, 480_000, 600_000, 600_000]);
    expect(warn).toHaveBeenCalledWith("RPC endpoint circuit opened", expect.objectContaining({
      from: "half-open", to: "open", cooldownMs: 600_000,
    }));
  });

  it("lets only one observation probe a recovering endpoint", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 3; index += 1) await observeWith(internal, calls);
    vi.advanceTimersByTime(RPC_BREAKER.cooldownMs);
    calls.length = 0;
    let answer!: (value: string) => void;
    const probe = withRpcFailover(ENDPOINTS, ({ client }: Endpoint) => {
      calls.push(client);
      return new Promise<string>((resolve) => { answer = resolve; });
    });
    const concurrent = observeWith(() => "primary", calls);
    await expect(concurrent).resolves.toBe("fallback");
    answer("primary");
    await expect(probe).resolves.toBe("primary");
    expect(calls).toEqual(["primary", "fallback"]);
    expect(state("primary.example")?.state).toBe("closed");
  });

  it("opens when more than 20% of at least ten observations in a minute failed", async () => {
    const calls: string[] = [];
    const pattern = [true, false, false, true, false, false, true, false, false, false];
    for (const fails of pattern) {
      await observeWith(() => fails ? internal() : "primary", calls, { attempts: 1 });
      vi.advanceTimersByTime(1_000);
    }
    expect(state("primary.example")).toMatchObject({ state: "closed", windowSamples: 10, windowFailures: 3 });
    await observeWith(internal, calls, { attempts: 1 });
    expect(state("primary.example")).toMatchObject({ state: "open", consecutiveFailures: 1 });
  });

  it("forgets failures older than the one-minute window", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      await observeWith(index % 3 === 0 ? internal : () => "primary", calls, { attempts: 1 });
    }
    vi.advanceTimersByTime(RPC_BREAKER.windowMs);
    await observeWith(internal, calls, { attempts: 1 });
    expect(state("primary.example")).toMatchObject({ state: "closed", windowSamples: 1, windowFailures: 1 });
  });

  it("still tries every endpoint when all are open, least recently opened first", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 3; index += 1) await observeWith(internal, calls);
    vi.advanceTimersByTime(1_000);
    for (let index = 0; index < 3; index += 1) {
      await withRpcFailover([FALLBACK], async () => { throw internal(); }, { baseDelayMs: 0 }).catch(() => undefined);
    }
    expect(state("fallback.example")?.state).toBe("open");
    calls.length = 0;
    await expect(withRpcFailover(ENDPOINTS, async ({ client }: Endpoint) => {
      calls.push(client);
      if (client === "primary") throw internal();
      return "fallback";
    }, { baseDelayMs: 0 })).resolves.toBe("fallback");
    expect(calls).toEqual(["primary", "fallback"]);
    expect(state("fallback.example")?.state).toBe("closed");
  });

  it("does not charge a local pacing refusal to the endpoint, and moves on without waiting", async () => {
    const calls: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      await expect(observeWith(() => new RpcQueueUnavailableError(), calls)).resolves.toBe("fallback");
    }
    expect(calls).toEqual(Array.from({ length: 5 }, () => ["primary", "fallback"]).flat());
    expect(state("primary.example")).toMatchObject({ state: "closed", consecutiveFailures: 0, windowFailures: 0 });
    expect(warn).not.toHaveBeenCalledWith("RPC endpoint attempt failed", expect.anything());
  });

  it("retries a rate-limited endpoint no sooner than its Retry-After", async () => {
    const calls: string[] = [];
    let first = true;
    const pending = observeWith(() => {
      if (!first) return "primary";
      first = false;
      return rateLimited("3");
    }, calls);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toEqual(["primary"]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe("primary");
    expect(calls).toEqual(["primary", "primary"]);
  });

  it("moves on from a long Retry-After at once and defers the endpoint until it passes", async () => {
    const calls: string[] = [];
    await expect(observeWith(() => rateLimited("30"), calls)).resolves.toBe("fallback");
    expect(calls).toEqual(["primary", "fallback"]);
    calls.length = 0;
    await expect(observeWith(() => "primary", calls)).resolves.toBe("fallback");
    expect(calls).toEqual(["fallback"]);
    vi.advanceTimersByTime(30_000);
    calls.length = 0;
    await expect(observeWith(() => "primary", calls)).resolves.toBe("primary");
  });

  it("keeps a bounded retry with backoff on the last endpoint", async () => {
    const calls: string[] = [];
    let fallbackFailures = 2;
    const pending = withRpcFailover(ENDPOINTS, async ({ client }: Endpoint) => {
      calls.push(client);
      if (client === "primary" || fallbackFailures-- > 0) throw internal();
      return client;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toEqual(["primary", "fallback"]);
    await vi.advanceTimersByTimeAsync(6_001);
    await expect(pending).resolves.toBe("fallback");
    expect(calls).toEqual(["primary", "fallback", "fallback", "fallback"]);
  });

  it("rethrows a revert that returned data at once, without failover", async () => {
    const abi = parseAbi(["function getProvider(uint256) view returns (uint256)", "error Error(string)"]);
    const revert = new ContractFunctionExecutionError(new ContractFunctionRevertedError({
      abi, functionName: "getProvider", data: encodeErrorResult({ abi, errorName: "Error", args: ["not registered"] }),
    }), { abi, functionName: "getProvider", args: [1n] });
    const calls: string[] = [];
    await expect(observeWith(() => revert, calls)).rejects.toBe(revert);
    expect(calls).toEqual(["primary"]);
    expect(state("primary.example")).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("logs endpoint faults with host, method, code, attempt and latency, throttled, never the URL or key", async () => {
    const fetchFn = stubRpcFetch(({ url }) => url.startsWith("https://primary.example")
      ? { error: { code: -32603, message: "Internal error" } }
      : { result: "0x10" });
    const endpoints = [PRIMARY, FALLBACK].map(({ host, url }) => ({
      host, url, client: createPublicClient({ chain: base, transport: rpcReadTransport(url, { fetchFn }) }),
    }));
    const read = () => withRpcFailover(endpoints, ({ client }) => client.getBlockNumber(), { operation: "test.head" });
    await expect(read()).resolves.toBe(16n);
    await expect(read()).resolves.toBe(16n);
    const failures = warn.mock.calls.filter(([message]) => message === "RPC endpoint attempt failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]![1]).toMatchObject({
      host: "primary.example", endpoint: "primary", operation: "test.head", method: "eth_blockNumber",
      reason: "internal_error", code: -32603, attempt: 1, suppressed: 0,
    });
    expect(typeof (failures[0]![1] as { latencyMs: unknown }).latencyMs).toBe("number");
    vi.advanceTimersByTime(60_000);
    await expect(read()).resolves.toBe(16n);
    const later = warn.mock.calls.filter(([message]) => message === "RPC endpoint attempt failed");
    expect(later.at(-1)![1]).toMatchObject({ suppressed: 1 });
    const logged = JSON.stringify([...warn.mock.calls, ...info.mock.calls]);
    expect(logged).not.toContain("test-key-0123");
    expect(logged).not.toContain("/v3/");
    expect(logged).not.toContain("https://");
  });

  it("reports a fallback selection at most once a minute per operation", async () => {
    const calls: string[] = [];
    const onFallback = vi.fn();
    await observeWith(internal, calls, { onFallback, attempts: 1 });
    await observeWith(internal, calls, { onFallback, attempts: 1 });
    expect(onFallback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await observeWith(internal, calls, { onFallback, attempts: 1 });
    expect(onFallback).toHaveBeenLastCalledWith(expect.objectContaining({ suppressed: 1 }));
  });

  it("keeps bounded state however many endpoints it has seen", async () => {
    for (let index = 0; index < 40; index += 1) {
      await withRpcFailover([{ host: `rpc-${index}.example`, client: null }], async () => "ok");
    }
    expect(rpcEndpointHealthSnapshot()).toHaveLength(32);
  });
});
