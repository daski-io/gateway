import { custom } from "viem";
import { describe, expect, it, vi } from "vitest";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";

interface Request {
  method: string;
}

function transportHarness() {
  let active = 0;
  let maximumActive = 0;
  const calls: string[] = [];
  const transport = orderedRpcTransport(custom({
    async request({ method }: Request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(method);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (method === "fail") throw new Error("planned failure");
      return method;
    },
  }))({ retryCount: 0 });
  const request = transport.request as (
    args: Request,
  ) => Promise<unknown>;
  return {
    calls,
    maximumActive: () => maximumActive,
    request,
  };
}

describe("orderedRpcTransport", () => {
  it("runs concurrent caller requests one at a time", async () => {
    const harness = transportHarness();

    await expect(Promise.all([
      harness.request({ method: "first" }),
      harness.request({ method: "second" }),
      harness.request({ method: "third" }),
    ])).resolves.toEqual(["first", "second", "third"]);

    expect(harness.calls).toEqual(["first", "second", "third"]);
    expect(harness.maximumActive()).toBe(1);
  });

  it("continues the queue after a request fails", async () => {
    const harness = transportHarness();
    const failed = harness.request({ method: "fail" });
    const recovered = harness.request({ method: "after" });

    await expect(failed).rejects.toThrow("planned failure");
    await expect(recovered).resolves.toBe("after");
    expect(harness.calls).toEqual(["fail", "after"]);
    expect(harness.maximumActive()).toBe(1);
  });
});

it("paces separate read clients sharing one endpoint without retrying a failed RPC", async () => {
  vi.useFakeTimers();
  try {
    const times: number[] = [];
    const build = () => orderedRpcTransport(custom({ request: async () => { times.push(Date.now()); return "ok"; } }),
      { scope: "shared-test-endpoint", maxPerMinute: 60, maxWaitMs: 5_000 })({ retryCount: 0 }).request;
    const a=build(), b=build();
    const pending=Promise.all([a({method:"eth_chainId"}),b({method:"eth_chainId"}),a({method:"eth_chainId"})]);
    await vi.runAllTimersAsync();await pending;
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1000);
  } finally { vi.useRealTimers(); }
});


it("a burst of optional quote clients cannot reserve slots ahead of evidence and signature reads", async () => {
  vi.useFakeTimers();
  try {
    const calls: { name: string; at: number }[] = [];
    const started = Date.now();
    const build = (name: string, maxWaitMs?: number) => orderedRpcTransport(custom({
      request: async () => { calls.push({ name, at: Date.now() - started }); return "ok"; },
    }), { scope: "quote-priority-test", maxPerMinute: 300, maxWaitMs })({ retryCount: 0 }).request;
    const quotes = Array.from({ length: 300 }, (_, i) => build("quote-" + i, 0)({ method: "eth_chainId" }));
    const quoteResults = Promise.allSettled(quotes);
    const evidence = build("evidence")({ method: "eth_chainId" });
    const signature = build("signature")({ method: "eth_chainId" });
    const settled = Promise.all([evidence, signature]);
    await vi.runAllTimersAsync();
    await settled;
    expect((await quoteResults).filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(calls).toEqual([
      { name: "quote-0", at: 0 }, { name: "evidence", at: 200 }, { name: "signature", at: 400 },
    ]);
  } finally { vi.useRealTimers(); }
});

it("cancels requests waiting behind a slow wire request without sending them after the deadline", async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    const wire = vi.fn(async ({ method }: Request) => {
      if (method === "slow") await new Promise<void>(resolve => { finish = resolve; });
      return method;
    });
    const request = orderedRpcTransport(custom({ request: wire }),
      { scope: "queue-timeout-test", maxPerMinute: 300, maxWaitMs: 100 })({ retryCount: 0 }).request;
    const first = request({ method: "slow" });
    await vi.advanceTimersByTimeAsync(0);
    const abandoned = Promise.allSettled([request({ method: "expired" })]);
    await vi.advanceTimersByTimeAsync(101);
    expect((await abandoned)[0]).toMatchObject({ status: "rejected" });
    finish(); await first;
    await vi.runAllTimersAsync();
    expect(wire.mock.calls.map(([args]) => args.method)).toEqual(["slow"]);
  } finally { vi.useRealTimers(); }
});

it("aborts a reserved pacing wait before dispatch and bounds per-client queue growth", async () => {
  vi.useFakeTimers();
  try {
    const wire = vi.fn(async () => "ok");
    const request = orderedRpcTransport(custom({ request: wire }),
      { scope: "queue-abort-test", maxPerMinute: 60 })({ retryCount: 0 }).request;
    await request({ method: "eth_chainId" });
    const controller = new AbortController();
    const pending = Promise.allSettled([request({ method: "eth_chainId" }, { signal: controller.signal } as never)]);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect((await pending)[0]).toMatchObject({ status: "rejected" });
    await vi.runAllTimersAsync();
    expect(wire).toHaveBeenCalledTimes(1);
    let finish!: () => void;
    const blocked = orderedRpcTransport(custom({ request: async () => new Promise(resolve => { finish = () => resolve("ok"); }) }))
      ({ retryCount: 0 }).request;
    const accepted = Array.from({ length: 64 }, () => blocked({ method: "eth_chainId" }));
    const results = Promise.allSettled(accepted);
    await expect(blocked({ method: "eth_chainId" })).rejects.toThrow("queue");
    await vi.advanceTimersByTimeAsync(2_001);
    finish();
    await results;
  } finally { vi.useRealTimers(); }
});
