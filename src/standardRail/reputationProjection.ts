import type { Address, Hex } from "viem";

export interface ProjectedReputationRecord {
  orderKey: Hex;
  providerAgentId: string;
  serviceId: Hex;
  payer: Address;
  grossAmount: bigint;
  paidAt: bigint;
  outcome: number;
  confirmation: number;
  outcomeAttestationDelay: bigint;
  outcomeRecorded: boolean;
  reputationEligible: boolean;
  refundedAmount: bigint;
  settlementTransactionHash: Hex | null;
  buyerAgentId: string | null;
  buyerName: string | null;
  outcomeId: string;
}

function rate(numerator: bigint, denominator: bigint): number | null {
  return denominator === 0n ? null : Number(numerator * 10_000n / denominator) / 100;
}

function satisfactionWeight(amount: bigint): bigint {
  const floor = 250_000n;
  let scaled = amount < floor ? floor : amount;
  let weight = 1n;
  while (scaled >= floor * 2n) {
    scaled /= 2n;
    weight++;
  }
  return weight;
}

function timestamp(seconds: bigint): string {
  const milliseconds = Number(seconds * 1_000n);
  const value = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(value.getTime())) {
    throw new Error("Reputation record contains an invalid payment timestamp");
  }
  return value.toISOString();
}

export function presentReputation(
  source: readonly ProjectedReputationRecord[],
  safeBlock: bigint,
) {
  const records = source.filter((record) => record.reputationEligible);
  const completed = records.filter((record) => record.outcomeRecorded && record.outcome === 0);
  const failed = records.filter((record) => record.outcomeRecorded && record.outcome === 1);
  const canceled = records.filter((record) => record.outcomeRecorded && record.outcome === 2);
  const confirmed = records.filter((record) => record.confirmation === 1);
  const notConfirmed = records.filter((record) => record.confirmation === 2);
  const completionSamples = BigInt(completed.length + failed.length + canceled.length);
  const confirmationSamples = BigInt(confirmed.length + notConfirmed.length);
  const confirmedWeight = confirmed.reduce(
    (total, record) => total + satisfactionWeight(record.grossAmount),
    0n,
  );
  const notConfirmedWeight = notConfirmed.reduce(
    (total, record) => total + satisfactionWeight(record.grossAmount),
    0n,
  );
  const fulfillmentTotal = completed.reduce(
    (total, record) => total + record.outcomeAttestationDelay,
    0n,
  );
  const recentPurchases = [...records]
    .sort((left, right) => left.paidAt === right.paidAt ? 0 : left.paidAt > right.paidAt ? -1 : 1)
    .slice(0, 50)
    .map((record) => ({
      orderKey: record.orderKey,
      txHash: record.settlementTransactionHash,
      payer: record.payer,
      buyerAgentId: record.buyerAgentId,
      buyerName: record.buyerName,
      amount: record.grossAmount.toString(),
      outcomeId: record.outcomeId,
      timestamp: timestamp(record.paidAt),
    }));

  return {
    transactionCount: records.length.toString(),
    completedCount: completed.length.toString(),
    failedCount: failed.length.toString(),
    canceledCount: canceled.length.toString(),
    completionSampleSize: completionSamples.toString(),
    completionRate: rate(BigInt(completed.length), completionSamples),
    confirmedCount: confirmed.length.toString(),
    notConfirmedCount: notConfirmed.length.toString(),
    confirmationSampleSize: confirmationSamples.toString(),
    buyerSatisfactionRate: rate(BigInt(confirmed.length), confirmationSamples),
    valueWeightedBuyerSatisfactionRate: rate(
      confirmedWeight,
      confirmedWeight + notConfirmedWeight,
    ),
    totalPaid: records.reduce((total, record) => total + record.grossAmount, 0n).toString(),
    totalRefunded: records.reduce((total, record) => total + record.refundedAmount, 0n).toString(),
    averageFulfillmentSeconds: completed.length > 0
      ? Number(fulfillmentTotal / BigInt(completed.length))
      : null,
    fulfillmentSampleSize: completed.length.toString(),
    recentPurchases,
    safeBlock: safeBlock.toString(),
  };
}
