import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  assertActivationCheckpoint,
  selectBoundRelease,
  verifyReleaseInterval,
  type ReleasedEvidence,
  type TransferEvidence,
} from "../src/standardRail/releaseEvidence.js";

const token = "0x1111111111111111111111111111111111111111" as Address;
const splitter = "0x2222222222222222222222222222222222222222" as Address;
const payer = "0x3333333333333333333333333333333333333333" as Address;
const payee = "0x4444444444444444444444444444444444444444" as Address;
const receiver = "0x5555555555555555555555555555555555555555" as Address;
const outcomeIdHash = `0x${"66".repeat(32)}` as Hex;
const policyVersionHash = `0x${"77".repeat(32)}` as Hex;
const listingCommitmentHash = `0x${"88".repeat(32)}` as Hex;

const hash = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

function transfer(args: {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
  from: Address;
  to: Address;
  value: bigint;
  blockHash?: Hex;
}): TransferEvidence {
  return {
    token,
    blockNumber: args.blockNumber,
    blockHash: args.blockHash ?? hash("a"),
    transactionIndex: args.transactionIndex,
    logIndex: args.logIndex,
    transactionHash: args.transactionHash,
    from: args.from,
    to: args.to,
    value: args.value,
  };
}

function release(args: {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
  sequence: bigint;
  gross: bigint;
  provider: bigint;
  commission: bigint;
}): ReleasedEvidence {
  return {
    splitter,
    blockNumber: args.blockNumber,
    blockHash: hash("b"),
    transactionIndex: args.transactionIndex,
    logIndex: args.logIndex,
    transactionHash: args.transactionHash,
    outcomeIdHash,
    listingEpoch: 3n,
    releaseSequence: args.sequence,
    policyVersionHash,
    listingCommitmentHash,
    grossAmount: args.gross,
    providerNetAmount: args.provider,
    daskiCommissionAmount: args.commission,
  };
}

function verify(args: {
  deposit: TransferEvidence;
  current: ReleasedEvidence;
  previous: ReleasedEvidence | null;
  credits: TransferEvidence[];
  payouts: TransferEvidence[];
}) {
  return verifyReleaseInterval({
    activationBlockNumber: 100n,
    startingTokenBalance: 50n,
    startingReleaseSequence: 7n,
    deposit: args.deposit,
    release: args.current,
    previousRelease: args.previous,
    credits: args.credits,
    payoutTransfers: args.payouts,
    token,
    splitter,
    providerPayee: payee,
    daskiCommissionReceiver: receiver,
    commissionBps: 1_000,
    outcomeIdHash,
    listingEpoch: 3n,
    policyVersionHash,
    listingCommitmentHash,
  });
}

describe("release evidence", () => {
  it("uses the signed starting balance for the first post-activation sequence", () => {
    const deposit = transfer({
      blockNumber: 101n, transactionIndex: 0, logIndex: 2,
      transactionHash: hash("1"), from: payer, to: splitter, value: 100n,
    });
    const current = release({
      blockNumber: 102n, transactionIndex: 1, logIndex: 7,
      transactionHash: hash("2"), sequence: 8n, gross: 150n,
      provider: 135n, commission: 15n,
    });
    const payouts = [
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 5,
        transactionHash: hash("2"), from: splitter, to: payee, value: 135n }),
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 6,
        transactionHash: hash("2"), from: splitter, to: receiver, value: 15n }),
    ];

    expect(verify({ deposit, current, previous: null, credits: [deposit], payouts }))
      .toMatchObject({ providerNetAmount: 90n, daskiCommissionAmount: 10n });
  });

  it("binds a later release among multiple releases in one wrapper transaction", () => {
    const wrapperTx = hash("3");
    const previous = release({
      blockNumber: 102n, transactionIndex: 1, logIndex: 7,
      transactionHash: wrapperTx, sequence: 8n, gross: 50n,
      provider: 45n, commission: 5n,
    });
    const deposit = transfer({
      blockNumber: 102n, transactionIndex: 1, logIndex: 10,
      transactionHash: wrapperTx, from: payer, to: splitter, value: 100n,
      blockHash: previous.blockHash,
    });
    const current = release({
      blockNumber: 102n, transactionIndex: 1, logIndex: 15,
      transactionHash: wrapperTx, sequence: 9n, gross: 100n,
      provider: 90n, commission: 10n,
    });
    const payouts = [
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 13,
        transactionHash: wrapperTx, from: splitter, to: payee, value: 90n,
        blockHash: current.blockHash }),
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 14,
        transactionHash: wrapperTx, from: splitter, to: receiver, value: 10n,
        blockHash: current.blockHash }),
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 16,
        transactionHash: wrapperTx, from: splitter, to: payee, value: 90n,
        blockHash: current.blockHash }),
      transfer({ blockNumber: 102n, transactionIndex: 1, logIndex: 17,
        transactionHash: wrapperTx, from: splitter, to: receiver, value: 10n,
        blockHash: current.blockHash }),
    ];

    const selected = selectBoundRelease({
      releases: [previous, current],
      binding: current,
      splitter,
      releaseSequence: 9n,
    });
    const first = verify({ deposit, current: selected, previous, credits: [deposit], payouts });
    const rebuilt = verify({ deposit, current: selected, previous, credits: [deposit], payouts });
    expect(first).toEqual(rebuilt);
    expect(first).toMatchObject({ providerNetAmount: 90n, daskiCommissionAmount: 10n });
  });

  it("rejects extra or reordered splitter-origin canonical-token payouts", () => {
    const transactionHash = hash("4");
    const deposit = transfer({
      blockNumber: 101n, transactionIndex: 0, logIndex: 2,
      transactionHash: hash("5"), from: payer, to: splitter, value: 100n,
    });
    const current = release({
      blockNumber: 102n, transactionIndex: 1, logIndex: 7,
      transactionHash, sequence: 8n, gross: 150n,
      provider: 135n, commission: 15n,
    });
    const providerPayout = transfer({
      blockNumber: 102n, transactionIndex: 1, logIndex: 5,
      transactionHash, from: splitter, to: payee, value: 135n,
    });
    const commissionPayout = transfer({
      blockNumber: 102n, transactionIndex: 1, logIndex: 6,
      transactionHash, from: splitter, to: receiver, value: 15n,
    });
    const extraPayout = transfer({
      blockNumber: 102n, transactionIndex: 1, logIndex: 4,
      transactionHash, from: splitter, to: payer, value: 1n,
    });

    expect(() => verify({
      deposit, current, previous: null, credits: [deposit],
      payouts: [providerPayout, commissionPayout, extraPayout],
    })).toThrow(/missing, reordered, or ambiguous/);
    expect(() => verify({
      deposit, current, previous: null, credits: [deposit],
      payouts: [
        { ...commissionPayout, logIndex: 5 },
        { ...providerPayout, logIndex: 6 },
      ],
    })).toThrow(/missing, reordered, or ambiguous/);
  });

  it("rejects duplicate credit positions and a noncontiguous predecessor", () => {
    const deposit = transfer({
      blockNumber: 101n, transactionIndex: 0, logIndex: 2,
      transactionHash: hash("4"), from: payer, to: splitter, value: 100n,
    });
    const current = release({
      blockNumber: 102n, transactionIndex: 1, logIndex: 7,
      transactionHash: hash("5"), sequence: 8n, gross: 150n,
      provider: 135n, commission: 15n,
    });
    expect(() => verify({
      deposit,
      current,
      previous: null,
      credits: [deposit, { ...deposit }],
      payouts: [],
    })).toThrow(/duplicate log position/);

    const wrongPrevious = { ...current, releaseSequence: 7n, logIndex: 6 };
    const later = { ...current, releaseSequence: 9n, logIndex: 9 };
    expect(() => verify({
      deposit,
      current: later,
      previous: wrongPrevious,
      credits: [deposit],
      payouts: [],
    })).toThrow(/Previous release boundary/);
  });

  it("rejects activation reorgs and evidence in the activation block", () => {
    expect(() => assertActivationCheckpoint({
      activationBlockNumber: 100n,
      expectedBlockHash: hash("a"),
      observedBlockHash: hash("b"),
      expectedTokenBalance: 50n,
      observedTokenBalance: 50n,
      expectedReleaseSequence: 7n,
      observedReleaseSequence: 7n,
    })).toThrow(/activation checkpoint/);

    expect(() => assertActivationCheckpoint({
      activationBlockNumber: 100n,
      expectedBlockHash: hash("a"),
      observedBlockHash: hash("a"),
      expectedTokenBalance: 50n,
      observedTokenBalance: 50n,
      expectedReleaseSequence: 7n,
      observedReleaseSequence: 7n,
      depositBlockNumber: 100n,
    })).toThrow(/activation checkpoint/);
  });
});
