import type {
  BazaarCompatibilityWiring,
  BazaarOrder,
  SettlementEvidenceInput,
} from "./types.js";
import type { BazaarLeaseGuard } from "./lease.js";

export type SettlementEvidenceResult =
  | { kind: "valid" }
  | { kind: "invalid" }
  | { kind: "ambiguous" };

export async function verifyBazaarSettlementEvidence(
  order: BazaarOrder,
  wiring: BazaarCompatibilityWiring,
  lease: BazaarLeaseGuard,
): Promise<SettlementEvidenceResult> {
  if (!order.settlementTransaction) return { kind: "invalid" };
  let response: unknown;
  try {
    lease.assertOwned();
    response = await wiring.evidenceVerifier.verify({
      transaction: order.settlementTransaction,
      chainId: order.chainId,
      token: order.token,
      payer: order.payer,
      nonce: order.nonce,
      payTo: order.payTo,
      grossAmount: order.grossAmount,
    }, lease.signal);
    lease.assertOwned();
  } catch {
    return { kind: "ambiguous" };
  }
  const evidence = parseSettlementEvidence(response);
  if (!evidence) return { kind: "ambiguous" };
  return evidence.finalized === true &&
    evidence.authorizationUsedEventCount === 1 &&
    evidence.matchingTransferEventCount === 1 &&
    evidence.transaction.toLowerCase() === order.settlementTransaction.toLowerCase() &&
    evidence.chainId === order.chainId &&
    evidence.token.toLowerCase() === order.token.toLowerCase() &&
    evidence.payer.toLowerCase() === order.payer.toLowerCase() &&
    evidence.nonce.toLowerCase() === order.nonce.toLowerCase() &&
    evidence.payTo.toLowerCase() === order.payTo.toLowerCase() &&
    evidence.grossAmount === order.grossAmount
    ? { kind: "valid" }
    : { kind: "invalid" };
}

type SettlementEvidence = SettlementEvidenceInput & {
  finalized: true;
  authorizationUsedEventCount: 1;
  matchingTransferEventCount: 1;
};

function parseSettlementEvidence(value: unknown): SettlementEvidence | null {
  if (!isRecord(value)) return null;
  const keys = [
    "transaction", "chainId", "token", "payer", "nonce", "payTo",
    "grossAmount", "finalized", "authorizationUsedEventCount",
    "matchingTransferEventCount",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    typeof value.transaction !== "string" || typeof value.chainId !== "bigint" ||
    typeof value.token !== "string" || typeof value.payer !== "string" ||
    typeof value.nonce !== "string" || typeof value.payTo !== "string" ||
    typeof value.grossAmount !== "bigint" || value.finalized !== true ||
    value.authorizationUsedEventCount !== 1 ||
    value.matchingTransferEventCount !== 1
  ) return null;
  return value as unknown as SettlementEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
