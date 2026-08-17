import { getAddress, type Address, type Hex } from "viem";

export interface PositionedEvidence {
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
}

export interface TransferEvidence extends PositionedEvidence {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

export interface ReleasedEvidence extends PositionedEvidence {
  splitter: Address;
  outcomeIdHash: Hex;
  listingEpoch: bigint;
  releaseSequence: bigint;
  policyVersionHash: Hex;
  listingCommitmentHash: Hex;
  grossAmount: bigint;
  providerNetAmount: bigint;
  daskiCommissionAmount: bigint;
}

export interface LogBinding extends PositionedEvidence {}

export function evidencePosition(
  value: Pick<PositionedEvidence, "blockNumber" | "transactionIndex" | "logIndex">,
): readonly [bigint, bigint, bigint] {
  return [
    value.blockNumber,
    BigInt(value.transactionIndex),
    BigInt(value.logIndex),
  ];
}

export function compareEvidencePosition(
  left: Pick<PositionedEvidence, "blockNumber" | "transactionIndex" | "logIndex">,
  right: Pick<PositionedEvidence, "blockNumber" | "transactionIndex" | "logIndex">,
): number {
  const a = evidencePosition(left);
  const b = evidencePosition(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
}

function sameBoundLog(value: PositionedEvidence, binding: LogBinding): boolean {
  return (
    compareEvidencePosition(value, binding) === 0 &&
    value.blockHash === binding.blockHash &&
    value.transactionHash === binding.transactionHash
  );
}

export function selectBoundDeposit(args: {
  transfers: readonly TransferEvidence[];
  binding: LogBinding;
  token: Address;
  payer: Address;
  splitter: Address;
  grossAmount: bigint;
}): TransferEvidence {
  const candidates = args.transfers.filter((event) =>
    sameBoundLog(event, args.binding)
  );
  if (candidates.length !== 1) {
    throw new Error("Receipt-bound deposit log is missing or ambiguous");
  }
  const deposit = candidates[0]!;
  if (
    getAddress(deposit.token) !== getAddress(args.token) ||
    getAddress(deposit.from) !== getAddress(args.payer) ||
    getAddress(deposit.to) !== getAddress(args.splitter) ||
    deposit.value !== args.grossAmount
  ) throw new Error("Receipt-bound deposit transfer is invalid");
  return deposit;
}

export function selectBoundRelease(args: {
  releases: readonly ReleasedEvidence[];
  binding: LogBinding;
  splitter: Address;
  releaseSequence: bigint;
}): ReleasedEvidence {
  const candidates = args.releases.filter((event) =>
    sameBoundLog(event, args.binding)
  );
  if (candidates.length !== 1) {
    throw new Error("Receipt-bound release log is missing or ambiguous");
  }
  const release = candidates[0]!;
  if (
    getAddress(release.splitter) !== getAddress(args.splitter) ||
    release.releaseSequence !== args.releaseSequence
  ) throw new Error("Receipt-bound release sequence is invalid");
  return release;
}

export function assertActivationCheckpoint(args: {
  activationBlockNumber: bigint;
  expectedBlockHash: Hex;
  observedBlockHash: Hex;
  expectedTokenBalance: bigint;
  observedTokenBalance: bigint;
  expectedReleaseSequence: bigint;
  observedReleaseSequence: bigint;
  depositBlockNumber?: bigint;
  releaseBlockNumber?: bigint;
}): void {
  if (
    args.observedBlockHash !== args.expectedBlockHash ||
    args.observedTokenBalance !== args.expectedTokenBalance ||
    args.observedReleaseSequence !== args.expectedReleaseSequence ||
    (args.depositBlockNumber !== undefined &&
      args.depositBlockNumber <= args.activationBlockNumber) ||
    (args.releaseBlockNumber !== undefined &&
      args.releaseBlockNumber <= args.activationBlockNumber)
  ) throw new Error("Splitter activation checkpoint does not match canonical history");
}

function insideInterval(
  event: PositionedEvidence,
  activationBlockNumber: bigint,
  previous: ReleasedEvidence | null,
  current: ReleasedEvidence,
): boolean {
  const afterBoundary = previous
    ? compareEvidencePosition(event, previous) > 0
    : event.blockNumber > activationBlockNumber;
  return afterBoundary && compareEvidencePosition(event, current) < 0;
}

function sortedUnique<T extends PositionedEvidence>(values: readonly T[]): T[] {
  const sorted = [...values].sort(compareEvidencePosition);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareEvidencePosition(sorted[index - 1]!, sorted[index]!) === 0) {
      throw new Error("Release interval contains a duplicate log position");
    }
  }
  return sorted;
}

export function verifyReleaseInterval(args: {
  activationBlockNumber: bigint;
  startingTokenBalance: bigint;
  startingReleaseSequence: bigint;
  deposit: TransferEvidence;
  release: ReleasedEvidence;
  previousRelease: ReleasedEvidence | null;
  credits: readonly TransferEvidence[];
  payoutTransfers: readonly TransferEvidence[];
  token: Address;
  splitter: Address;
  providerPayee: Address;
  daskiCommissionReceiver: Address;
  commissionBps: number;
  outcomeIdHash: Hex;
  listingEpoch: bigint;
  policyVersionHash: Hex;
  listingCommitmentHash: Hex;
}): {
  interval: TransferEvidence[];
  providerNetAmount: bigint;
  daskiCommissionAmount: bigint;
} {
  if (
    args.release.blockNumber <= args.activationBlockNumber ||
    args.release.releaseSequence <= args.startingReleaseSequence ||
    !Number.isSafeInteger(args.commissionBps) ||
    args.commissionBps <= 0 ||
    args.commissionBps >= 10_000
  ) throw new Error("Release is outside the activated sequence boundary");
  if (args.previousRelease) {
    if (
      args.previousRelease.releaseSequence + 1n !== args.release.releaseSequence ||
      args.previousRelease.releaseSequence < args.startingReleaseSequence ||
      args.previousRelease.blockNumber <= args.activationBlockNumber ||
      compareEvidencePosition(args.previousRelease, args.release) >= 0
    ) throw new Error("Previous release boundary is invalid");
  } else if (
    args.release.releaseSequence !== args.startingReleaseSequence + 1n
  ) throw new Error("First activated release sequence is not contiguous");

  const interval = sortedUnique(args.credits.filter((event) =>
    insideInterval(
      event,
      args.activationBlockNumber,
      args.previousRelease,
      args.release,
    )
  ));
  if (interval.some((event) =>
    getAddress(event.token) !== getAddress(args.token) ||
    getAddress(event.to) !== getAddress(args.splitter)
  )) throw new Error("Release interval contains an invalid credit");
  const targets = interval.filter((event) => sameBoundLog(event, args.deposit));
  if (targets.length !== 1) {
    throw new Error("Release interval omits the receipt-bound deposit");
  }
  const targetIndex = interval.indexOf(targets[0]!);
  const baseline = args.previousRelease ? 0n : args.startingTokenBalance;
  const cumulativeBefore = interval
    .slice(0, targetIndex)
    .reduce((sum, event) => sum + event.value, baseline);
  const cumulativeAfter = cumulativeBefore + args.deposit.value;
  const intervalGross = interval.reduce(
    (sum, event) => sum + event.value,
    baseline,
  );
  const basisPoints = BigInt(args.commissionBps);
  const commissionBefore = cumulativeBefore * basisPoints / 10_000n;
  const commissionAfter = cumulativeAfter * basisPoints / 10_000n;
  const daskiCommissionAmount = commissionAfter - commissionBefore;
  const providerNetAmount = args.deposit.value - daskiCommissionAmount;
  const totalCommission = intervalGross * basisPoints / 10_000n;

  const boundedPayouts = args.payoutTransfers.filter((event) =>
    insideInterval(
      event,
      args.activationBlockNumber,
      args.previousRelease,
      args.release,
    )
  );
  const payouts = sortedUnique(boundedPayouts.filter((event) =>
    getAddress(event.token) === getAddress(args.token) &&
    getAddress(event.from) === getAddress(args.splitter)
  ));
  if (
    args.release.outcomeIdHash !== args.outcomeIdHash ||
    args.release.listingEpoch !== args.listingEpoch ||
    args.release.policyVersionHash !== args.policyVersionHash ||
    args.release.listingCommitmentHash !== args.listingCommitmentHash ||
    args.release.grossAmount !== intervalGross ||
    args.release.providerNetAmount !== intervalGross - totalCommission ||
    args.release.daskiCommissionAmount !== totalCommission ||
    payouts.length !== 2 ||
    payouts.some((event) => event.transactionHash !== args.release.transactionHash) ||
    getAddress(payouts[0]!.to) !== getAddress(args.providerPayee) ||
    payouts[0]!.value !== intervalGross - totalCommission ||
    getAddress(payouts[1]!.to) !== getAddress(args.daskiCommissionReceiver) ||
    payouts[1]!.value !== totalCommission ||
    providerNetAmount <= 0n ||
    daskiCommissionAmount <= 0n
  ) throw new Error("Release payouts are missing, reordered, or ambiguous");
  return { interval, providerNetAmount, daskiCommissionAmount };
}
