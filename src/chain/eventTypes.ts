import type { Hex } from "../types.js";
import type { PaymentSettledEvent } from "./reader.js";

interface ChainLogLocation {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

export interface PaymentSettledProjectionEvent
  extends ChainLogLocation,
    PaymentSettledEvent {
  kind: "payment_settled";
  blockTimestamp: bigint;
  transactionHash: Hex;
}

export interface RefundedProjectionEvent extends ChainLogLocation {
  kind: "refunded";
  paymentId: bigint;
  cumulativeRefunded: bigint;
}

export interface PaymentRecordedProjectionEvent extends ChainLogLocation {
  kind: "payment_recorded";
  paymentId: bigint;
  providerAgentId: bigint;
  buyerAgentId: bigint;
  serviceId: Hex;
  reputationEligible: boolean;
}

export interface OutcomeRecordedProjectionEvent extends ChainLogLocation {
  kind: "outcome_recorded";
  paymentId: bigint;
  providerAgentId: bigint;
  buyerAgentId: bigint;
  serviceId: Hex;
  outcomeCode: number;
  fulfillmentSeconds: bigint;
  attestationUid: Hex;
}

export interface ConfirmationProjectionEvent extends ChainLogLocation {
  kind: "confirmation_submitted";
  paymentId: bigint;
  providerAgentId: bigint;
  buyerAgentId: bigint;
  serviceId: Hex;
  confirmationCode: number;
  attestationUid: Hex;
}

export interface ConfirmationRevokedProjectionEvent extends ChainLogLocation {
  kind: "confirmation_revoked";
  attestationUid: Hex;
}

export type ChainProjectionEvent =
  | PaymentSettledProjectionEvent
  | RefundedProjectionEvent
  | PaymentRecordedProjectionEvent
  | OutcomeRecordedProjectionEvent
  | ConfirmationProjectionEvent
  | ConfirmationRevokedProjectionEvent;

export interface ChainProjectionDescriptor {
  chainId: number;
  paymentRouterAddress: Hex;
  reputationStorageAddress: Hex;
  easAddress: Hex;
  confirmationSchemaUid: Hex;
  startBlock: bigint;
}

export function compareProjectionEvents(
  left: ChainProjectionEvent,
  right: ChainProjectionEvent,
): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}
