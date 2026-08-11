import type { BazaarLeaseGuard } from "./lease.js";
import type { Hex } from "../types.js";
import { isHex32 } from "../util/evmValidation.js";
import type {
  BazaarCompatibilityWiring,
  BazaarRefundEvidenceInput,
} from "./types.js";
import type { BazaarRefundWorkItem } from "./refundLeaseStore.js";
import { callBazaarAdapter } from "./adapterCall.js";

export interface VerifiedBazaarRefundEvidence {
  evidenceHash: Hex;
  blockHash: Hex;
  transferLogIndex: number;
}

export async function verifyBazaarRefundEvidence(input: {
  work: BazaarRefundWorkItem;
  wiring: BazaarCompatibilityWiring;
  lease: BazaarLeaseGuard;
}): Promise<VerifiedBazaarRefundEvidence | "pending"> {
  const transaction = input.work.refundTransaction;
  if (!transaction) return "pending";
  let response: unknown;
  try {
    input.lease.assertOwned();
    response = await callBazaarAdapter({
      timeoutMs: input.wiring.adapterCallTimeoutMs,
      signal: input.lease.signal,
      operation: (signal) => input.wiring.refundEvidenceVerifier.verify({
        transaction,
        chainId: input.work.chainId,
        token: input.work.token,
        refundWallet: input.work.refundWallet,
        payer: input.work.payer,
        grossAmount: input.work.grossAmount,
      }, signal),
    });
    input.lease.assertOwned();
  } catch {
    return "pending";
  }
  const evidence = parseRefundEvidence(response);
  if (!evidence) return "pending";
  const valid = evidence.finalized === true &&
    evidence.matchingTransferEventCount === 1 &&
    evidence.transaction.toLowerCase() === transaction.toLowerCase() &&
    evidence.chainId === input.work.chainId &&
    evidence.token.toLowerCase() === input.work.token.toLowerCase() &&
    evidence.refundWallet.toLowerCase() === input.work.refundWallet.toLowerCase() &&
    evidence.payer.toLowerCase() === input.work.payer.toLowerCase() &&
    evidence.grossAmount === input.work.grossAmount &&
    evidence.refundWallet.toLowerCase() !== evidence.payer.toLowerCase() &&
    isNonzeroHex32(evidence.evidenceHash) &&
    isNonzeroHex32(evidence.blockHash) &&
    Number.isSafeInteger(evidence.transferLogIndex) &&
    evidence.transferLogIndex >= 0;
  return valid ? {
    evidenceHash: evidence.evidenceHash,
    blockHash: evidence.blockHash,
    transferLogIndex: evidence.transferLogIndex,
  } : "pending";
}

function isNonzeroHex32(value: unknown): value is Hex {
  return isHex32(value) && !/^0x0{64}$/i.test(value);
}

type RefundEvidenceResult = BazaarRefundEvidenceInput & {
  finalized: true;
  matchingTransferEventCount: 1;
  evidenceHash: Hex;
  blockHash: Hex;
  transferLogIndex: number;
};

function parseRefundEvidence(value: unknown): RefundEvidenceResult | null {
  if (!isRecord(value)) return null;
  const keys = [
    "transaction", "chainId", "token", "refundWallet", "payer",
    "grossAmount", "finalized", "matchingTransferEventCount", "evidenceHash",
    "blockHash", "transferLogIndex",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    typeof value.transaction !== "string" || typeof value.chainId !== "bigint" ||
    typeof value.token !== "string" || typeof value.refundWallet !== "string" ||
    typeof value.payer !== "string" || typeof value.grossAmount !== "bigint" ||
    value.finalized !== true || value.matchingTransferEventCount !== 1 ||
    typeof value.evidenceHash !== "string" || typeof value.blockHash !== "string" ||
    typeof value.transferLogIndex !== "number"
  ) return null;
  return value as unknown as RefundEvidenceResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
