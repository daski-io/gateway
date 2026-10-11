import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, parseAbiItem, toHex, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardChainEvidence } from "../src/standardRail/evidence.js";
import type { FacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";

const released = parseAbiItem("event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)");
const SPLITTER = getAddress("0x" + "5a".repeat(20));
const OUTCOME = `0x${"a1".repeat(32)}` as Hex, POLICY = `0x${"a2".repeat(32)}` as Hex, COMMITMENT = `0x${"a3".repeat(32)}` as Hex;
const ACTIVATION = 47_437_814n, RELEASE = 47_953_947n;

function releasedLog(blockNumber: bigint, releaseSequence: bigint, logIndex = 2) {
  return {
    address: SPLITTER, blockNumber, blockHash: pad(toHex(blockNumber), { size: 32 }), logIndex,
    transactionHash: pad(toHex(blockNumber * 10n + BigInt(logIndex)), { size: 32 }), transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: [released], args: { outcomeIdHash: OUTCOME, listingEpoch: 1n, releaseSequence } }),
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [POLICY, COMMITMENT, 1_000_000n, 975_000n, 25_000n]),
  };
}

const unusedLock: FacilitatorNonceLock = { run: async work => work() };

/** A splitter whose history holds `history`; records every log window the evidence reads. */
function search(history: ReturnType<typeof releasedLog>[]) {
  const windows: string[] = [];
  const getLogs = vi.fn(async ({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args: { releaseSequence: bigint } }) => {
    windows.push(`${fromBlock}-${toBlock}`);
    return history.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock &&
      log.topics[3] === pad(toHex(args.releaseSequence), { size: 32 }));
  });
  const evidence = new StandardChainEvidence({ evidenceRpcUrls: ["https://rpc-a.example"], releasePrivateKey: `0x${"11".repeat(32)}`,
    finalityConfirmations: 12 } as unknown as StandardRailConfig, baseSepolia, unusedLock);
  const previousRelease = (current: ReturnType<typeof releasedLog>, sequence: bigint) =>
    (evidence as unknown as { previousRelease(...args: unknown[]): Promise<{ blockNumber: bigint; releaseSequence: bigint } | null> })
      .previousRelease({ getLogs }, SPLITTER, ACTIVATION, 0n,
        { blockNumber: current.blockNumber, blockHash: current.blockHash, transactionIndex: 0, logIndex: current.logIndex,
          transactionHash: current.transactionHash, releaseSequence: sequence }, 1000);
  return { windows, previousRelease };
}

describe("previous release search", () => {
  it("finds a recent predecessor in one window however old the listing is", async () => {
    const current = releasedLog(RELEASE, 5n);
    const { windows, previousRelease } = search([releasedLog(ACTIVATION + 40n, 1n), releasedLog(RELEASE - 120n, 4n), current]);
    const previous = await previousRelease(current, 5n);
    expect(previous?.blockNumber).toBe(RELEASE - 120n);
    expect(previous?.releaseSequence).toBe(4n);
    expect(windows).toEqual([`${RELEASE - 9_999n}-${RELEASE}`]);
  });

  it("walks back to an older predecessor and binds the one before this release in the same block", async () => {
    const current = releasedLog(RELEASE, 3n, 5);
    const older = search([releasedLog(RELEASE - 25_000n, 2n), current]);
    expect((await older.previousRelease(current, 3n))?.blockNumber).toBe(RELEASE - 25_000n);
    expect(older.windows).toHaveLength(3);
    const sameBlock = search([releasedLog(RELEASE, 2n, 1), current]);
    expect((await sameBlock.previousRelease(current, 3n))?.blockNumber).toBe(RELEASE);
  });

  it("still refuses a release whose predecessor is missing or ambiguous", async () => {
    const current = releasedLog(RELEASE, 5n);
    const missing = search([current]);
    await expect(missing.previousRelease(current, 5n)).rejects.toThrow(/missing or ambiguous/);
    expect(missing.windows.at(-1)).toBe(`${ACTIVATION + 1n}-${ACTIVATION + 1n + (RELEASE - ACTIVATION - 1n) % 10_000n}`);
    const twice = search([releasedLog(RELEASE - 50n, 4n, 1), releasedLog(RELEASE - 40n, 4n, 1), current]);
    await expect(twice.previousRelease(current, 5n)).rejects.toThrow(/missing or ambiguous/);
  });
});
