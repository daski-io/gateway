import { randomUUID } from "node:crypto";
import { custom, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";
import {
  ContractVerificationCallerLimit,
  ContractVerificationSemaphore,
  createContractVerificationEndpoint,
  createPayerSignatureVerifier,
} from "../src/standardRail/payerSignature.js";

// Every reader of one RPC endpoint shares RPC_READ_MAX_PER_MINUTE. Payment
// proofs are served first (G5-H1), but a sustained proof backlog (concurrent
// purchases, recovery) must not starve the ordinary readers that renew
// purchase freshness, answer wallet queries and verify contract-account
// payers. All runs use the real transport, the default budget and simulated
// time; the verification runs use the real verifier and endpoint client.
const RATE = 300;
const SPACING = 60_000 / RATE;
const LATENCY = 50;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Read = (args: { method: string }) => Promise<unknown>;

afterEach(() => vi.useRealTimers());

function sharedEndpoint() {
  const scope = "https://rpc-" + randomUUID() + ".invalid/";
  const sent: Array<{ method: string; at: number }> = [];
  const wire = async (method: string) => {
    sent.push({ method, at: Date.now() });
    await pause(LATENCY);
    return method === "eth_getCode" ? "0x6001" : "0x1626ba7e" + "0".repeat(56);
  };
  const client = (method: string, pacing: { required?: boolean } = {}) => {
    const request = orderedRpcTransport(custom({ request: async () => wire(method) }),
      { scope, maxPerMinute: RATE, ...pacing })({ retryCount: 0 } as never).request as Read;
    return () => request({ method });
  };
  // The same endpoint over HTTP JSON-RPC, for the real verification endpoint client.
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = await wire(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { scope, sent, client, fetchFn };
}

// Concurrent purchases keep the payment-proof client's queue non-empty, and
// `busy` ordinary clients re-read as soon as each read returns.
function load(endpoint: ReturnType<typeof sharedEndpoint>, busy: number, proofs: boolean) {
  let done = false;
  const proof = endpoint.client("proof", { required: true });
  const loops: Promise<void>[] = [];
  if (proofs) loops.push((async () => {
    while (!done) await Promise.all([proof(), proof(), proof()]).catch(() => pause(LATENCY));
  })());
  for (let i = 0; i < busy; i++) {
    const reader = endpoint.client("busy");
    loops.push((async () => { while (!done) await reader().catch(() => pause(LATENCY)); })());
  }
  return { stop: async () => { done = true; await vi.advanceTimersByTimeAsync(30_000); await Promise.all(loops); } };
}

describe("ordinary readers beside a sustained payment-proof backlog", () => {
  it.each([5, 8])("serves every read of a sporadic two-second reader beside %i busy clients", async busy => {
    vi.useFakeTimers();
    const endpoint = sharedEndpoint();
    const background = load(endpoint, busy, true);
    await vi.advanceTimersByTimeAsync(2_000);
    // The purchase-freshness refresh or a wallet query: one read with the
    // default two-second wait every two to three seconds, so that its
    // arrivals sweep every phase of the other clients' reads.
    const sporadic = endpoint.client("sporadic");
    let done = false;
    const outcomes = { ok: 0, failed: 0 };
    const reader = (async () => {
      for (let read = 0; !done; read++) {
        await sporadic().then(() => outcomes.ok++, () => outcomes.failed++);
        await pause(2_000 + (read % 5) * 250);
      }
    })();
    await vi.advanceTimersByTimeAsync(60_000);
    done = true;
    await background.stop();
    await reader;

    // Before, from five busy clients on, all but the first expired at two seconds.
    expect(outcomes.failed).toBe(0);
    expect(outcomes.ok).toBeGreaterThanOrEqual(10);
    // Proofs kept every other slot, and the endpoint rate held.
    const proofShare = endpoint.sent.filter(entry => entry.method === "proof").length / endpoint.sent.length;
    expect(proofShare).toBeGreaterThan(0.45);
    for (let i = 1; i < endpoint.sent.length; i++)
      expect(endpoint.sent[i]!.at - endpoint.sent[i - 1]!.at).toBeGreaterThanOrEqual(SPACING);
  }, 60_000);

  it("does not count slots that went to proof reads against an ordinary read's wait", async () => {
    vi.useFakeTimers();
    const endpoint = sharedEndpoint();
    const background = load(endpoint, 0, true);
    await vi.advanceTimersByTimeAsync(1_000);
    const started = Date.now();
    // Four ordinary clients queue a read each behind the backlog; each read
    // waits at most 700 ms.
    const bounded = (name: string) => orderedRpcTransport(custom({ request: async () => {
      endpoint.sent.push({ method: name, at: Date.now() });
      return "0x";
    } }), { scope: endpoint.scope, maxPerMinute: RATE, maxWaitMs: 700 })({ retryCount: 0 } as never)
      .request({ method: "eth_chainId" }).then(() => "served", (error: Error) => error.name);
    const reads = Promise.all(["a", "b", "c", "d"].map(bounded));
    await vi.advanceTimersByTimeAsync(3_000);
    const outcomes = await reads;
    await background.stop();

    const at = (name: string) => endpoint.sent.find(entry => entry.method === name)?.at;
    const yielded = (until: number) => endpoint.sent.filter(entry =>
      entry.method === "proof" && entry.at > started && entry.at < until).length;
    // Proofs and ordinary reads alternate. The third ordinary read waits
    // 1.2 s in all, but only 600 ms of it on its own class: the slots proofs
    // took meanwhile moved its limit later.
    expect(outcomes).toEqual(["served", "served", "served", "RpcQueueUnavailableError"]);
    const third = at("c")! - started;
    expect(third).toBe(1_200);
    expect(third - yielded(at("c")!) * SPACING).toBe(600);
    // The fourth still expires on its own class: the pacing gap it met and
    // the three ordinary reads ahead of it take 800 ms.
    expect(at("d")).toBeUndefined();
  });
});

describe("concurrent legitimate contract-account verifications", () => {
  const typedData = { domain: { name: "DaskiStandardWallet", version: "1", chainId: 84532 },
    types: { Probe: [{ name: "nonce", type: "bytes32" }] }, primaryType: "Probe",
    message: { nonce: "0x" + "ab".repeat(32) } } as const;

  it.each([
    [2, true], [2, false], [3, false],
  ])("completes %i at a time beside three busy clients (proof backlog: %s)", async (concurrent, proofs) => {
    vi.useFakeTimers();
    const endpoint = sharedEndpoint();
    const verifier = createPayerSignatureVerifier({
      accountTypes: ["eoa", "contract"], timeoutMs: 5_000,
      endpoints: [createContractVerificationEndpoint({ url: endpoint.scope, chain: baseSepolia, timeoutMs: 5_000,
        maxPerMinute: RATE, fetchFn: endpoint.fetchFn })],
      semaphore: new ContractVerificationSemaphore(8), callerLimit: new ContractVerificationCallerLimit(2),
    });
    const background = load(endpoint, 3, proofs);
    await vi.advanceTimersByTimeAsync(3_000);
    const outcomes: Record<string, number> = {};
    // Independent payers, each verifying again one second after an answer, for a minute.
    const payers = Array.from({ length: concurrent }, async (_, index) => {
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        const outcome = await verifier.verifyPayerTypedData({
          payer: ("0x" + String(index + 1).repeat(40)) as Hex, typedData,
          signature: ("0x" + "c0".repeat(300)) as Hex,
        }).then(() => "verified", (error: { code?: string }) => error.code ?? "uncoded");
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        await pause(1_000);
      }
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await background.stop();
    await Promise.all(payers);

    // Before, two at a time beside a proof backlog verified 5 and answered 16
    // unavailable; every attempt now verifies.
    expect(Object.keys(outcomes)).toEqual(["verified"]);
    expect(outcomes.verified).toBeGreaterThanOrEqual(concurrent * 10);
  }, 60_000);
});
