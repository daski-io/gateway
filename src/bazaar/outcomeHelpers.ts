import type {
  PaymentRequired,
  SettleResponse,
} from "@x402/core/types";
import type { Hex } from "viem";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import { listingOfferHash } from "./offer.js";
import type { ParsedBazaarPayment } from "./payment.js";
import { canonicalRequestHash } from "./requestBinding.js";
import type { ClaimOrderInput } from "./store.js";
import type { BazaarListing, BazaarOrder } from "./types.js";

export type BazaarOutcomeResult = {
  status: number;
  body: Record<string, unknown>;
  paymentRequired?: PaymentRequired;
  paymentResponse?: SettleResponse;
};

export function createClaimInput(
  listing: BazaarListing,
  payment: ParsedBazaarPayment,
  random: (size: number) => Buffer,
  paidRetryReceivedAt: bigint,
): ClaimOrderInput {
  const orderRecordId = nonzeroRandomHex(random);
  const offer = listing.offer.message;
  return {
    orderRecordId,
    orderHandle: Buffer.from(orderRecordId.slice(2), "hex").toString("base64url"),
    authorizationDigest: payment.authorizationDigest,
    signatureDigest: payment.signatureDigest,
    chainId: offer.chainId,
    token: offer.token.toLowerCase() as Hex,
    payer: payment.authorization.from,
    nonce: payment.authorization.nonce,
    providerAgentId: offer.providerAgentId,
    listingEpoch: offer.listingEpoch,
    listingCommitment: offer.listingCommitment,
    outcomeId: offer.outcomeId,
    resource: listing.resourceUrl,
    requestHash: canonicalRequestHash(offer),
    offerHash: listingOfferHash(offer),
    grossAmount: offer.grossAmount,
    payTo: offer.payTo.toLowerCase() as Hex,
    authorizationValidBefore: payment.authorization.validBefore,
    authorizationValidAfter: payment.authorization.validAfter,
    paidRetryReceivedAt,
    paymentMaxTimeoutSeconds: offer.paymentMaxTimeoutSeconds,
    refundPolicyVersion: listing.policyVersion,
  };
}

export function sameOrderBinding(order: BazaarOrder, input: ClaimOrderInput): boolean {
  return order.authorizationDigest === input.authorizationDigest &&
    order.chainId === input.chainId && order.token === input.token &&
    order.payer === input.payer && order.nonce === input.nonce &&
    order.providerAgentId === input.providerAgentId &&
    order.listingEpoch === input.listingEpoch &&
    order.listingCommitment === input.listingCommitment &&
    order.outcomeId === input.outcomeId && order.resource === input.resource &&
    order.requestHash === input.requestHash && order.offerHash === input.offerHash &&
    order.grossAmount === input.grossAmount && order.payTo === input.payTo &&
    order.authorizationValidBefore === input.authorizationValidBefore;
}

export function validSettlementEvidence(
  response: SettleResponse,
  order: BazaarOrder,
): boolean {
  return isHex32(response.transaction) && response.transaction !== `0x${"00".repeat(32)}` &&
    isHexAddress(response.payer) &&
    response.payer.toLowerCase() === order.payer.toLowerCase() &&
    response.network === `eip155:${order.chainId}` &&
    (response.amount === undefined || response.amount === order.grossAmount.toString());
}

export function normalizedPaymentResponse(
  response: SettleResponse,
  order: BazaarOrder,
): SettleResponse {
  return paymentResponseFromOrder(order, response.transaction);
}

export function paymentResponseFromOrder(
  order: BazaarOrder,
  transaction: string | null = order.settlementTransaction,
): SettleResponse {
  if (!transaction) throw new Error("Bazaar settled order has no transaction");
  return {
    success: true,
    transaction,
    network: `eip155:${order.chainId}`,
    payer: order.payer,
    amount: order.grossAmount.toString(),
  };
}

export function existingOutcomeResult(order: BazaarOrder): BazaarOutcomeResult {
  if (order.state === "dispatched" && order.settlementTransaction) {
    return successOutcome(order.orderHandle, order.resource, {
      success: true,
      transaction: order.settlementTransaction,
      network: `eip155:${order.chainId}`,
      payer: order.payer,
      amount: order.grossAmount.toString(),
    });
  }
  if ([
    "attempt_opened", "settle_started", "settle_confirmed", "settled",
    "dispatch_started", "dispatch_ambiguous",
  ].includes(order.state)) {
    return { status: 202, body: { orderHandle: order.orderHandle, state: "processing" } };
  }
  return {
    status: 409,
    body: { orderHandle: order.orderHandle, error: order.failureCode ?? "order_terminal" },
  };
}

export function successOutcome(
  handle: string,
  resourceUrl: string,
  response: SettleResponse,
): BazaarOutcomeResult {
  const base = new URL(resourceUrl).origin;
  return {
    status: 200,
    paymentResponse: response,
    body: {
      orderHandle: handle,
      lifecycle: {
        challengeUrl: `${base}/x402/v1/orders/${handle}/challenge`,
        redeemUrl: `${base}/x402/v1/orders/${handle}/actions`,
      },
    },
  };
}

export function failureOutcome(status: number, code: string): BazaarOutcomeResult {
  return { status, body: { error: code } };
}

function nonzeroRandomHex(random: (size: number) => Buffer): Hex {
  const bytes = random(32);
  if (bytes.length !== 32 || bytes.every((byte) => byte === 0)) {
    throw new Error("Bazaar random source returned an invalid identifier");
  }
  return `0x${bytes.toString("hex")}` as Hex;
}
