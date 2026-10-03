import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import {
  CONTRACT_VERIFICATION_CONCURRENCY,
  CONTRACT_VERIFICATION_PER_CALLER,
  ContractVerificationCallerLimit,
  ContractVerificationSemaphore,
  createContractVerificationEndpoint,
  createPayerSignatureVerifier,
} from "../src/standardRail/payerSignature.js";
const { startStub, policy, listing, PAYER, NONCE, TX, GROSS, TOKEN, ORACLE, ORACLE_CODE } =
  await import(new URL("./fixtures/releaseRpc.mjs", import.meta.url).href);

// G5-H1: an unauthenticated flood of contract-account signatures kept the
// verification client's eight lanes waiting at the shared endpoint, so the
// payment-proof reads queued behind them expired after two seconds on every
// attempt and settled orders drifted toward LEGAL_HOLD. Round-6 review A:
// anonymous purchase attempts screened their participants through the
// payment-proof client itself, so every held attempt queued ahead of every
// proof. Everything below is the production code path over real viem and
// HTTP JSON-RPC: one shared StandardChainEvidence, the real verifier and
// verification endpoint, and serialized background readers, all on one RPC
// endpoint at the default RPC_READ_MAX_PER_MINUTE.
const DEFAULT_BUDGET = 300;
const VERIFY_TIMEOUT_MS = 5_000; // PAYER_SIGNATURE_VERIFY_TIMEOUT_MS default
const PURCHASES = 2;
const BACKGROUND_READERS = 3;
// Four attacking clients at their per-caller share fill every lane; one more
// loop per attacker is refused outright.
const ATTACKERS = CONTRACT_VERIFICATION_CONCURRENCY / CONTRACT_VERIFICATION_PER_CALLER;
const LOOPS_PER_ATTACKER = CONTRACT_VERIFICATION_PER_CALLER + 1;
// Claimed purchase attempts screening at once, as unfunded signers can hold
// them until the facilitator refuses each one.
const SCREENING_ATTEMPTS = 30;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("payment proofs under a contract-signature verification flood and pre-payment screening", () => {
  it.each([50, 200])("complete every paid proof at the default budget and %i ms RPC latency", async latency => {
    const stub = await startStub({ latency: () => latency });
    let done = false;
    try {
      const evidence = new StandardChainEvidence({evidenceRpcUrls: [stub.url], rpcReadMaxPerMinute: DEFAULT_BUDGET,
        finalityConfirmations: 5, environment: "mainnet", releasePrivateKey: ("0x" + "11".repeat(32)) as Hex,
        manifest: {chainEvidencePolicy: {payload: policy}}} as never, base,
        {run: (work: () => Promise<unknown>) => work()} as never);
      const callers = new AsyncLocalStorage<string>();
      const verifier = createPayerSignatureVerifier({
        accountTypes: ["eoa", "contract"], timeoutMs: VERIFY_TIMEOUT_MS,
        endpoints: [createContractVerificationEndpoint({url: stub.url, chain: base, timeoutMs: VERIFY_TIMEOUT_MS,
          maxPerMinute: DEFAULT_BUDGET})],
        semaphore: new ContractVerificationSemaphore(CONTRACT_VERIFICATION_CONCURRENCY),
        callerLimit: new ContractVerificationCallerLimit(CONTRACT_VERIFICATION_PER_CALLER),
        caller: () => callers.getStore(),
      });
      const typedData = {domain: {name: "DaskiStandardWallet", version: "1", chainId: 8453},
        types: {Probe: [{name: "nonce", type: "bytes32"}]}, primaryType: "Probe", message: {nonce: NONCE}} as const;
      const outcomes: Record<string, number> = {};
      const refusals: Array<{retryable?: boolean; requiresNewSignature?: boolean}> = [];
      const flood = Array.from({length: ATTACKERS * LOOPS_PER_ATTACKER}, (_, index) =>
        callers.run("198.51.100." + (1 + index % ATTACKERS), async () => {
          while (!done) {
            const outcome = await verifier.verifyPayerTypedData({payer: PAYER, typedData,
              signature: ("0x" + "12".repeat(65)) as Hex, context: {field: "payload.signature", phase: "payment_validation"}})
              .then(() => "verified", (error: {code?: string; retryable?: boolean; requiresNewSignature?: boolean}) => {
                refusals.push(error);
                return error.code ?? "uncoded";
              });
            outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
            // A refused attacker comes straight back, at HTTP round-trip pace.
            if (outcome !== "verified") await pause(20);
          }
        }));
      const screenings = {passed: 0, refused: 0, sanctioned: 0};
      const screening = Array.from({length: SCREENING_ATTEMPTS}, async () => {
        while (!done) {
          await evidence.assertNotSanctioned(ORACLE as Address, keccak256(ORACLE_CODE), [PAYER as Address])
            .then(() => screenings.passed++, (error: Error) => {
              if (error.message === "SANCTIONS_ADDRESS_REJECTED") screenings.sanctioned++;
              else screenings.refused++;
            });
          await pause(20);
        }
      });
      const background = {ok: 0, failed: 0};
      const readers = Array.from({length: BACKGROUND_READERS}, async () => {
        const client = createPublicClient({chain: base, transport: orderedRpcTransport(
          http(stub.url, {retryCount: 0, timeout: 20_000}), {scope: stub.url, maxPerMinute: DEFAULT_BUDGET})});
        while (!done) {
          try { await client.request({method: "eth_getCode", params: [TOKEN, "latest"]}); background.ok++; }
          catch { background.failed++; await pause(50); }
        }
      });
      await pause(500);
      const started = Date.now();
      const proofs = await Promise.allSettled(Array.from({length: PURCHASES}, async () => {
        const order = {payer: PAYER, grossAmount: GROSS.toString(), updatedAt: new Date()} as never;
        const deposit = await evidence.proveDeposit({order, listing, transactionHash: TX, paymentNonce: NONCE});
        return evidence.releaseAndProve({order, listing, deposit});
      }));
      const elapsed = Date.now() - started;
      done = true;
      await Promise.all([...flood, ...readers, ...screening]);

      expect(proofs.map(result => result.status)).toEqual(Array(PURCHASES).fill("fulfilled"));
      for (const result of proofs) expect((result as PromiseFulfilledResult<unknown>).value)
        .toMatchObject({providerNetAmount: 975_000n, daskiCommissionAmount: 25_000n});
      // Unloaded, these proofs take about 11 s; served first, they keep at
      // least every other slot however much other work waits.
      expect(elapsed).toBeLessThan(45_000);
      // The flood really ran: verifications held every lane and were answered.
      expect(outcomes.verified).toBeGreaterThan(0);
      // Whatever the load refused or expired is the endpoint's, never the signature's.
      expect(Object.keys(outcomes).filter(code => code !== "verified")).toEqual(
        outcomes.SIGNATURE_VERIFICATION_UNAVAILABLE ? ["SIGNATURE_VERIFICATION_UNAVAILABLE"] : []);
      expect(outcomes.SIGNATURE_VERIFICATION_UNAVAILABLE).toBeGreaterThan(0);
      for (const refusal of refusals) expect(refusal).toMatchObject({retryable: true, requiresNewSignature: false});
      // Screening reached the endpoint as one ordinary reader among the
      // others, and what it could not serve was refused, never reported as a
      // sanctions finding.
      expect(stub.log.some((entry: {to?: string}) => entry.to === "0xca11bde05977b3631167028862be2a173976ca11")).toBe(true);
      expect(screenings.passed + screenings.refused).toBeGreaterThan(0);
      expect(screenings.sanctioned).toBe(0);
      // Background readers kept getting slots, and the endpoint rate held.
      expect(background.ok).toBeGreaterThan(0);
      for (let i = 1; i < stub.log.length; i++)
        expect(stub.log[i].arrived - stub.log[i - 1].arrived).toBeGreaterThanOrEqual(170);
    } finally {
      done = true;
      await stub.close();
    }
  }, 90_000);
});
