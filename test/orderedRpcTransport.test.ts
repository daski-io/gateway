import { randomUUID } from "node:crypto";
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
    const abandoned = Promise.allSettled([request({ method: "expired" }, { deadline: Date.now() + 100 } as never)]);
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
    const cancelQueue = new AbortController();
    const accepted = Array.from({ length: 64 }, () => blocked({ method: "eth_chainId" }, { signal: cancelQueue.signal } as never));
    const results = Promise.allSettled(accepted);
    await expect(blocked({ method: "eth_chainId" })).rejects.toThrow("queue");
    await vi.advanceTimersByTimeAsync(1);
    cancelQueue.abort();
    finish();
    await results;
  } finally { vi.useRealTimers(); }
});

it("returns cancelled endpoint capacity to the next required read",async()=>{
 vi.useFakeTimers();
 try{
  const sent:number[]=[];
  const request=orderedRpcTransport(custom({request:async()=>{sent.push(Date.now());return "ok";}}),
    {scope:"reclaimed-capacity",maxPerMinute:300})({retryCount:0}).request;
  const started=Date.now();await request({method:"eth_chainId"});
  const cancel=new AbortController();
  const canceled=Promise.allSettled([request({method:"eth_chainId"},{signal:cancel.signal} as never)]);
  await vi.advanceTimersByTimeAsync(1);cancel.abort();await canceled;
  const next=request({method:"eth_chainId"});await vi.runAllTimersAsync();await next;
  expect(sent.map(value=>value-started)).toEqual([0,200]);
 }finally{vi.useRealTimers();}
});

describe("required proof reads at a shared endpoint", () => {
  const client = (scope: string, name: string, sent: Array<{ name: string; at: number }>, started: number,
    pacing: { required?: boolean; concurrency?: number; presented?: number; maxWaitMs?: number; maxQueued?: number;
      maxPerMinute?: number } = {},
    wire?: () => Promise<unknown>) =>
    orderedRpcTransport(custom({ request: async ({ method }: Request) => {
      sent.push({ name: name + ":" + method, at: Date.now() - started });
      return wire ? wire() : "ok";
    } }), { scope, maxPerMinute: 300, ...pacing })({ retryCount: 0 }).request as (
      args: Request, options?: { deadline?: number; signal?: AbortSignal },
    ) => Promise<unknown>;

  it("serves a required read before other waiting reads, never more than one other read apart", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ name: string; at: number }> = [];
      const started = Date.now();
      const scope = "required-priority-" + randomUUID();
      const verify = client(scope, "verify", sent, started, { concurrency: 8, maxWaitMs: 5_000 });
      const [a, b] = [client(scope, "a", sent, started), client(scope, "b", sent, started)];
      const proof = client(scope, "proof", sent, started, { required: true });
      const flood = Promise.allSettled(Array.from({ length: 8 }, (_, i) => verify({ method: "v" + i })));
      const others = Promise.allSettled([a({ method: "x" }), b({ method: "x" })]);
      const proofs = Promise.all([proof({ method: "p1" }), proof({ method: "p2" }), proof({ method: "p3" })]);
      await vi.runAllTimersAsync();
      await proofs;
      expect((await others).map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await flood).map(result => result.status)).toEqual(Array(8).fill("fulfilled"));
      // The previous FIFO served the first proof read only after seven waiting
      // verification lanes and both readers, at its two-second limit.
      expect(sent.slice(0, 7)).toEqual([
        { name: "verify:v0", at: 0 }, { name: "proof:p1", at: 200 }, { name: "a:x", at: 400 },
        { name: "proof:p2", at: 600 }, { name: "b:x", at: 800 }, { name: "proof:p3", at: 1000 },
        { name: "verify:v1", at: 1200 },
      ]);
      // The endpoint rate is unchanged: one read per 200 ms at 300/min.
      expect(sent.map(entry => entry.at)).toEqual(Array.from({ length: 13 }, (_, i) => i * 200));
    } finally { vi.useRealTimers(); }
  });

  it("keeps a required read waiting past the two-second bound while other reads expire at it", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ name: string; at: number }> = [];
      const started = Date.now();
      const scope = "required-wait-" + randomUUID();
      // 20/min: a 3 s slot spacing, longer than the default two-second wait.
      const proof = client(scope, "proof", sent, started, { required: true, maxPerMinute: 20 });
      const other = client(scope, "other", sent, started, { maxPerMinute: 20 });
      await proof({ method: "first" });
      const waiting = Promise.allSettled([other({ method: "late" }), proof({ method: "second" }),
        proof({ method: "bounded" }, { deadline: Date.now() + 1_000 })]);
      await vi.runAllTimersAsync();
      const [late, second, bounded] = await waiting;
      expect(late).toMatchObject({ status: "rejected", reason: { name: "RpcQueueUnavailableError" } });
      expect(second).toMatchObject({ status: "fulfilled" });
      // An explicit caller deadline stays authoritative for required reads.
      expect(bounded).toMatchObject({ status: "rejected", reason: { name: "RpcQueueUnavailableError" } });
      expect(sent).toEqual([{ name: "proof:first", at: 0 }, { name: "proof:second", at: 3_000 }]);
    } finally { vi.useRealTimers(); }
  });

  it("presents one read per client to the endpoint queue whatever its lanes", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ name: string; at: number }> = [];
      const started = Date.now();
      const scope = "one-waiter-" + randomUUID();
      const verify = client(scope, "verify", sent, started, { concurrency: 8, maxWaitMs: 5_000 });
      const reader = client(scope, "reader", sent, started);
      const flood = Promise.all(Array.from({ length: 8 }, (_, i) => verify({ method: "v" + i })));
      await vi.advanceTimersByTimeAsync(1);
      const read = reader({ method: "registry" });
      await vi.runAllTimersAsync();
      await Promise.all([flood, read]);
      // Before, the reader queued behind all seven waiting lanes (1.6 s).
      expect(sent.slice(0, 3).map(entry => entry.name)).toEqual(["verify:v0", "verify:v1", "reader:registry"]);
      expect(sent.find(entry => entry.name === "reader:registry")?.at).toBe(400);
    } finally { vi.useRealTimers(); }
  });

  it("presents at most its configured number of reads to the endpoint queue", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ name: string; at: number }> = [];
      const started = Date.now();
      const scope = "two-waiters-" + randomUUID();
      const verify = client(scope, "verify", sent, started, { concurrency: 8, presented: 2, maxWaitMs: 5_000 });
      const reader = client(scope, "reader", sent, started);
      const flood = Promise.all(Array.from({ length: 8 }, (_, i) => verify({ method: "v" + i })));
      await vi.advanceTimersByTimeAsync(1);
      const read = reader({ method: "registry" });
      await vi.runAllTimersAsync();
      await Promise.all([flood, read]);
      // Two verification reads wait ahead of the reader, never all seven.
      expect(sent.slice(0, 4).map(entry => entry.name)).toEqual(["verify:v0", "verify:v1", "verify:v2", "reader:registry"]);
      expect(sent.find(entry => entry.name === "reader:registry")?.at).toBe(600);
      expect(sent.map(entry => entry.at)).toEqual(Array.from({ length: 9 }, (_, i) => i * 200));
      expect(() => orderedRpcTransport(custom({ request: async () => "ok" }),
        { scope: "x", concurrency: 2, presented: 3 })({ retryCount: 0 })).toThrow("Invalid RPC presentation");
    } finally { vi.useRealTimers(); }
  });

  it("finishes the operations it started before starting queued ones", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<{ name: string; at: number }> = [];
      const started = Date.now();
      const verify = client("operation-order-" + randomUUID(), "verify", sent, started, { concurrency: 8, maxWaitMs: 5_000 });
      // Each operation is a code lookup then a call under one abort signal, like a payer verification.
      const operation = async (name: string) => {
        const signal = new AbortController().signal;
        await verify({ method: name + ".code" }, { signal });
        await verify({ method: name + ".call" }, { signal });
      };
      const all = Promise.all(["op1", "op2", "op3"].map(operation));
      await vi.runAllTimersAsync();
      await all;
      // FIFO would send every code lookup before any call, so under contention none would finish in time.
      expect(sent).toEqual([
        { name: "verify:op1.code", at: 0 }, { name: "verify:op2.code", at: 200 }, { name: "verify:op1.call", at: 400 },
        { name: "verify:op2.call", at: 600 }, { name: "verify:op3.code", at: 800 }, { name: "verify:op3.call", at: 1000 },
      ]);
    } finally { vi.useRealTimers(); }
  });

  it("refuses at once a read the client could only queue behind its busy lanes", async () => {
    let finish!: () => void;
    const hung = new Promise<void>(resolve => { finish = resolve; });
    const sent: Array<{ name: string; at: number }> = [];
    const request = client("bounded-lanes-" + randomUUID(), "verify", sent, Date.now(),
      { concurrency: 2, maxQueued: 2, maxPerMinute: 60_000, maxWaitMs: 5_000 }, () => hung.then(() => "ok"));
    const inFlight = [request({ method: "a" }), request({ method: "b" })];
    await new Promise(resolve => setTimeout(resolve, 20));
    const queued = [request({ method: "c" }), request({ method: "d" })];
    await expect(request({ method: "e" })).rejects.toThrow("RPC read queue is full");
    finish();
    await expect(Promise.all([...inFlight, ...queued])).resolves.toEqual(["ok", "ok", "ok", "ok"]);
    expect(sent.map(entry => entry.name)).toEqual(["verify:a", "verify:b", "verify:c", "verify:d"]);
    expect(() => orderedRpcTransport(custom({ request: async () => "ok" }), { scope: "x", maxQueued: 0 }))
      .toThrow("Invalid RPC queue bound");
  });

  it("returns a cancelled read's queue place at once, before its lane comes round", async () => {
    let finish!: () => void;
    const hung = new Promise<void>(resolve => { finish = resolve; });
    const sent: Array<{ name: string; at: number }> = [];
    const request = client("released-queue-" + randomUUID(), "verify", sent, Date.now(),
      { concurrency: 1, maxQueued: 1, maxPerMinute: 60_000, maxWaitMs: 5_000 }, () => hung.then(() => "ok"));
    const inFlight = request({ method: "a" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const cancel = new AbortController();
    const abandoned = request({ method: "b" }, { signal: cancel.signal });
    await expect(request({ method: "c" })).rejects.toThrow("RPC read queue is full");
    cancel.abort();
    await expect(abandoned).rejects.toThrow("RPC read queue");
    // The lane is still busy with "a", yet the cancelled read no longer holds the only queue place.
    const next = request({ method: "d" });
    finish();
    await expect(Promise.all([inFlight, next])).resolves.toEqual(["ok", "ok"]);
    expect(sent.map(entry => entry.name)).toEqual(["verify:a", "verify:d"]);
  });
});
