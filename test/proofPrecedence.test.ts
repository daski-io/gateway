import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";
import { ViemRegistrationEvidenceVerifier } from "../src/serviceRegistration/evidence.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
const { fetchStub, policy, listing, PAYER, NONCE, TX, GROSS, TOKEN, RECEIVER, ORACLE, ORACLE_CODE } =
  await import(new URL("./fixtures/releaseRpc.mjs", import.meta.url).href);

// What else reads the endpoint must not slow a paid order's proofs: they are
// served first at the shared endpoint, ahead of registration proofs and of
// every ordinary read. Real StandardChainEvidence and the registration
// verifier's own client over viem's HTTP transport, an in-process JSON-RPC
// with 50 ms latency, the default budget and simulated time.
const RATE = 300;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function endpoint() {
  const rpc = fetchStub({ latency: () => 50 });
  vi.stubGlobal("fetch", rpc.fetchFn);
  const url = `https://rpc-${Math.random().toString(16).slice(2)}.invalid/`;
  const evidence = new StandardChainEvidence({ evidenceRpcUrls: [url], rpcReadMaxPerMinute: RATE,
    finalityConfirmations: 5, environment: "mainnet", releasePrivateKey: ("0x" + "11".repeat(32)) as Hex,
    manifest: { chainEvidencePolicy: { payload: policy } } } as never, base,
    { run: (work: () => Promise<unknown>) => work() } as never);
  return { rpc, url, evidence };
}

// The ordinary readers of the endpoint (wallet queries, the marketplace
// reader, reputation and confirmation state), each re-reading at once.
function busyReaders(url: string, count: number, until: () => boolean): Promise<void>[] {
  return Array.from({ length: count }, async () => {
    const client = createPublicClient({ chain: base, transport: orderedRpcTransport(
      http(url, { retryCount: 0, timeout: 20_000 }), { scope: url, maxPerMinute: RATE }) });
    while (!until()) {
      try { await client.request({ method: "eth_getCode", params: [TOKEN, "latest"] }); } catch { await pause(50); }
    }
  });
}

// One purchase's proofs, as settleClaimedOrder runs them after settlement.
async function timedProof(evidence: StandardChainEvidence): Promise<number> {
  const started = Date.now();
  let settled = false, result: unknown;
  void (async () => {
    const order = { payer: PAYER, grossAmount: GROSS.toString(), updatedAt: new Date() } as never;
    const deposit = await evidence.proveDeposit({ order, listing, transactionHash: TX, paymentNonce: NONCE });
    return evidence.releaseAndProve({ order, listing, deposit });
  })().then(value => { result = value; }, error => { result = error; }).finally(() => { settled = true; });
  while (!settled && Date.now() - started < 3_600_000) await vi.advanceTimersByTimeAsync(250);
  expect(result).toMatchObject({ providerNetAmount: 975_000n, daskiCommissionAmount: 25_000n });
  return Date.now() - started;
}

// The registration verifier's client, exactly as the gateway builds it.
function registrationClient(url: string): PublicClient {
  const splitterCreationCode = "0x6000" as Hex;
  const verifier = new ViemRegistrationEvidenceVerifier(
    { chainId: 8453, usdc: { address: TOKEN }, marketplaceContracts: {}, finalityTag: "finalized" } as never,
    { evidenceRpcUrls: [url], rpcReadMaxPerMinute: RATE,
      manifest: { chainEvidencePolicy: { payload: policy }, railCapabilityRequirements: {} },
      splitterCreationCodeHash: keccak256(splitterCreationCode), splitterFactoryRuntimeCodeHash: keccak256("0x6001"),
      dynamicListingPolicy: { splitterCreationCode, daskiCommissionReceiver: RECEIVER, commissionBps: 250,
        splitterFactory: "0x" + "5f".repeat(20) } } as never,
    base, {} as never);
  return (verifier as unknown as { clients: Array<{ client: PublicClient }> }).clients[0]!.client;
}

describe("payment proofs beside registration proofs", () => {
  it("keep their pace while registration proofs stay backlogged, and registration keeps progressing", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    let registrationReads = 0;
    for (const registrationBacklog of [false, true]) {
      const { url, evidence } = endpoint();
      let done = false;
      const loops = busyReaders(url, 3, () => done);
      if (registrationBacklog) {
        const registration = registrationClient(url);
        // verifySplitter's batch: twelve concurrent reads, one kick after another.
        loops.push((async () => {
          while (!done) await Promise.all(Array.from({ length: 12 }, () =>
            registration.request({ method: "eth_getCode", params: [TOKEN, "latest"] }).then(() => registrationReads++)));
        })());
      }
      await vi.advanceTimersByTimeAsync(2_000);
      const before = registrationReads;
      times.push(await timedProof(evidence));
      if (registrationBacklog) expect(registrationReads - before).toBeGreaterThanOrEqual(10);
      done = true;
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all(loops);
    }
    const [alone, besideRegistration] = times as [number, number];
    // Before, registration proofs shared the payment proofs' level, and this
    // proof took 21.5 s beside them instead of 10.25 s.
    expect(alone).toBeLessThan(12_000);
    expect(besideRegistration).toBeLessThanOrEqual(alone * 1.05);
  }, 60_000);
});

describe("payment proofs beside anonymous pre-payment screening", () => {
  // Every claimed purchase attempt screens its participants before the
  // facilitator is reached; an unfunded signer is enough to open one, and a
  // held attempt screens again until the facilitator refuses it.
  it.each([30, 160])("keep their pace while %i attempts screen at once, and every screening settles promptly", async attempts => {
    vi.useFakeTimers();
    const { url, evidence, rpc } = endpoint();
    let done = false;
    const loops = busyReaders(url, 3, () => done);
    const screenings = { passed: 0, refused: 0, longest: 0 };
    loops.push(...Array.from({ length: attempts }, async () => {
      while (!done) {
        const started = Date.now();
        await evidence.assertNotSanctioned(ORACLE as Address, keccak256(ORACLE_CODE), [PAYER as Address])
          .then(() => screenings.passed++, (error: Error) => {
            // The endpoint's refusal, never a sanctions finding.
            expect(error.message).not.toBe("SANCTIONS_ADDRESS_REJECTED");
            screenings.refused++;
          });
        screenings.longest = Math.max(screenings.longest, Date.now() - started);
        await pause(300);
      }
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    const elapsed = await timedProof(evidence);
    done = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(loops);

    // Before, each held attempt added about 5.6 s: 176 s at 30 and 904 s,
    // past the 900 s evidence deadline, at 160. The proofs now take what they
    // take beside the three readers alone.
    expect(elapsed).toBeLessThan(12_000);
    // Screening kept its share of the ordinary reads, and what the endpoint
    // could not serve was refused within its bounded waits, not queued.
    expect(screenings.passed).toBeGreaterThan(0);
    expect(screenings.refused).toBeGreaterThan(0);
    expect(screenings.longest).toBeLessThan(20_000);
    expect(rpc.log.some((entry: { to?: string }) => entry.to === "0xca11bde05977b3631167028862be2a173976ca11")).toBe(true);
  }, 60_000);
});
