import type { BazaarCompatibilityWiring, BazaarOrder } from "./types.js";
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
  let evidence;
  try {
    lease.assertOwned();
    evidence = await wiring.evidenceVerifier.verify({
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
