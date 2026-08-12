import { getAddress, type Hex } from "viem";
import { canonicalHash } from "./canonical.js";

export interface GrossRefundIntent {
  refundId: Hex;
  orderId: string;
  payer: Hex;
  token: Hex;
  amount: string;
  providerShare: string;
  daskiShare: string;
  providerReservationId: Hex;
  daskiReservationId: Hex;
  leg: "gross";
  refundReason: "buyer_requested" | "provider_failed";
  depositEvidenceHash: Hex;
  releaseEvidenceHash: Hex;
  refundPolicyHash: Hex;
  dispositionEvidenceHash: Hex;
  activeRefundAttemptSequence: 1;
  dueAt: number;
}

export function contributionReservationId(args: {
  contribution: "provider" | "daski";
  orderId: string;
  payer: Hex;
  token: Hex;
  amount: string;
  listingManifestHash: Hex;
}): Hex {
  return canonicalHash(args);
}

export function buildGrossRefundIntent(args: {
  orderId: string;
  payer: Hex;
  token: Hex;
  grossAmount: string;
  providerAmount: string;
  daskiAmount: string;
  providerReservationId: Hex;
  daskiReservationId: Hex;
  refundReason: GrossRefundIntent["refundReason"];
  depositEvidenceHash: Hex;
  releaseEvidenceHash: Hex;
  refundPolicyHash: Hex;
  dispositionEvidenceHash: Hex;
  dueAt: number;
}): GrossRefundIntent {
  const grossAmount = BigInt(args.grossAmount);
  const providerAmount = BigInt(args.providerAmount);
  const daskiAmount = BigInt(args.daskiAmount);
  if (grossAmount <= 0n || providerAmount <= 0n || daskiAmount <= 0n) {
    throw new Error("Refund allocation amounts must be positive");
  }
  if (providerAmount + daskiAmount !== grossAmount) {
    throw new Error("Refund allocation does not equal the exact gross amount");
  }
  if (!Number.isSafeInteger(args.dueAt) || args.dueAt <= 0) {
    throw new Error("Refund obligation deadline is invalid");
  }
  const obligation = {
    orderId: args.orderId,
    payer: args.payer,
    token: args.token,
    amount: grossAmount.toString(),
    providerShare: providerAmount.toString(),
    daskiShare: daskiAmount.toString(),
    providerReservationId: args.providerReservationId,
    daskiReservationId: args.daskiReservationId,
    leg: "gross" as const,
    refundReason: args.refundReason,
    depositEvidenceHash: args.depositEvidenceHash,
    releaseEvidenceHash: args.releaseEvidenceHash,
    refundPolicyHash: args.refundPolicyHash,
    dispositionEvidenceHash: args.dispositionEvidenceHash,
    activeRefundAttemptSequence: 1 as const,
    dueAt: args.dueAt,
  };
  return { refundId: canonicalHash(obligation), ...obligation };
}

export function validateGrossRefundIntent(
  value: unknown,
  expected: {
    orderId: string;
    payer: Hex;
    token: Hex;
    grossAmount: string;
    providerAmount: string;
    daskiAmount: string;
    providerReservationId: Hex;
    daskiReservationId: Hex;
    depositEvidenceHash: Hex;
    releaseEvidenceHash: Hex;
    refundPolicyHash: Hex;
  },
): GrossRefundIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted refund intent is malformed");
  }
  const intent = value as GrossRefundIntent;
  const keys = [
    "refundId", "orderId", "payer", "token", "amount", "providerShare", "daskiShare",
    "providerReservationId", "daskiReservationId", "leg", "refundReason",
    "depositEvidenceHash", "releaseEvidenceHash", "refundPolicyHash",
    "dispositionEvidenceHash", "activeRefundAttemptSequence", "dueAt",
  ].sort();
  if (Object.keys(intent).sort().join(",") !== keys.join(",")) {
    throw new Error("Persisted refund intent has an open shape");
  }
  const { refundId, ...obligation } = intent;
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(refundId) || canonicalHash(obligation) !== refundId ||
    intent.orderId !== expected.orderId || getAddress(intent.payer) !== getAddress(expected.payer) ||
    getAddress(intent.token) !== getAddress(expected.token) || intent.amount !== expected.grossAmount ||
    intent.providerShare !== expected.providerAmount || intent.daskiShare !== expected.daskiAmount ||
    intent.providerReservationId !== expected.providerReservationId ||
    intent.daskiReservationId !== expected.daskiReservationId || intent.leg !== "gross" ||
    !["buyer_requested", "provider_failed"].includes(intent.refundReason) ||
    intent.depositEvidenceHash !== expected.depositEvidenceHash ||
    intent.releaseEvidenceHash !== expected.releaseEvidenceHash ||
    intent.refundPolicyHash !== expected.refundPolicyHash ||
    !/^0x[0-9a-fA-F]{64}$/.test(intent.dispositionEvidenceHash) ||
    intent.activeRefundAttemptSequence !== 1 ||
    !Number.isSafeInteger(intent.dueAt) || intent.dueAt <= 0
  ) throw new Error("Persisted refund intent conflicts with the reserved obligation");
  return intent;
}
