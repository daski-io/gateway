import { describe, expect, it, vi } from "vitest";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
const hash = `0x${"ab".repeat(32)}` as const;
const payer = `0x${"22".repeat(20)}` as const;
const args = { token: payer, payer, nonce: hash, validBefore: 500, fromBlock: 1n };
function harness(timestamp: bigint, used: boolean, canceled: boolean) {
  const client = { getBlock: vi.fn(async () => ({ number: 20n, hash, timestamp })),
    readContract: vi.fn(async () => used) };
  const evidence = Object.assign(Object.create(StandardChainEvidence.prototype), {
    config: { finalityTag: "finalized", manifest: { chainEvidencePolicy: { payload: { maximumLogPageEvents: 100 } } } },
    observe: (work: (endpoint: unknown) => Promise<unknown>) => work({ client }),
    tokenPolicyFacts: vi.fn(async () => undefined),
    boundedLogs: async () => canceled ? [{ transactionHash: hash }] : [],
  }) as StandardChainEvidence;
  return { evidence, client };
}
describe("parked authorization finality", () => {
  it("does not expire an authorization while finalized chain time is before its boundary", async () => {
    const onObserved = vi.fn(async () => undefined);
    expect(await harness(499n, false, false).evidence.proveAuthorizationUnpaid({ ...args, onObserved })).toBeNull();
    expect(onObserved).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: "20", nonceUsed: false, validBefore: 500 }));
  });
  it("accepts unused-at-finalized-expiry and records the observation block", async () => {
    const h = harness(500n, false, false);
    expect(await h.evidence.proveAuthorizationUnpaid(args)).toMatchObject({ kind: "finalized-expiry-unused", blockNumber: "20", blockHash: hash });
    expect(h.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 20n }));
  });
  it("never mistakes a used nonce flag for payment or cancellation", async () => {
    expect(await harness(999n, true, false).evidence.proveAuthorizationUnpaid(args)).toBeNull();
  });
  it("recognizes a finalized nonce cancellation independently of expiry", async () => {
    expect(await harness(300n, true, true).evidence.proveAuthorizationUnpaid(args)).toMatchObject({ kind: "finalized-cancellation", transactionHash: hash });
  });
});
