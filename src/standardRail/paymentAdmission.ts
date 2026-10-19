import { isDatabaseUnavailableError, sqlState, TransactionOutcomeUnknownError } from "../db/transientTransaction.js";
import type { Hex } from "../types.js";
import { standardRailError } from "./errors.js";
import type { StandardOrderRecord } from "./types.js";

/** The order as read again after a failed claim; "unread" when that read failed too. */
export type ClaimedOrderReading = StandardOrderRecord | null | "unread";

/**
 * The buyer's answer to a payment claim that did not commit
 * (StandardRailStore.claimAuthorization), which runs before any facilitator
 * call. Every answer here is either a refusal the database decided, with the
 * existing code for the same condition where the wire already has one, or a
 * statement that nothing was decided. An identical submission whose claim
 * did commit is a replay; the caller answers that before asking here. Any
 * other error is returned unchanged.
 */
export function paymentAdmissionFailure(error: unknown, context: {
  orderId: string;
  intentId: string;
  paymentPayloadHash: Hex;
  current: ClaimedOrderReading;
}): unknown {
  const logContext = { orderId: context.orderId, intentId: context.intentId };
  // The claim may have committed: only reconciliation by the payment
  // identifier can say, and recovery drives a committed claim either way.
  if (error instanceof TransactionOutcomeUnknownError) {
    return standardRailError("PAYMENT_PENDING_RECONCILIATION", {
      phase: "payment_validation",
      message: "The payment claim's outcome is not yet confirmed",
      internalMessage: `payment claim COMMIT outcome unknown: ${causeMessage(error.cause)}`,
      cause: error,
      logContext: { ...logContext, commitOutcomeUnknown: true },
    });
  }
  if (isDatabaseUnavailableError(error)) {
    const state = sqlState(error);
    return standardRailError("PAYMENT_ADMISSION_UNAVAILABLE", {
      internalMessage: `payment claim did not commit: ${causeMessage(error)}`,
      cause: error,
      logContext: { ...logContext, ...(state ? { sqlstate: state } : {}) },
    });
  }
  const refusal = error instanceof Error ? error.message : undefined;
  switch (refusal) {
    // Another order holds this authorization: the answer the pre-claim check
    // gives for the same condition.
    case "PAYMENT_AUTHORIZATION_ALREADY_CLAIMED":
      return standardRailError("PAYMENT_IDENTIFIER_CONFLICT", {
        field: "payment-identifier", cause: error, logContext,
      });
    // validatePayment refuses the same payer this way before the claim.
    case "READINESS_PAYER_MISMATCH":
      return standardRailError("AUTHORIZATION_MISMATCH", {
        field: "payload.authorization.from",
        message: "Payment payer differs from the readiness quote",
        cause: error,
        logContext,
      });
    case "OUTCOME_CAPACITY_EXHAUSTED":
      return standardRailError("OUTCOME_CAPACITY_EXHAUSTED", { cause: error, logContext });
    case "ORDER_NOT_FOUND":
      return standardRailError("CHALLENGE_EXPIRED", {
        message: "The order for this challenge no longer exists", cause: error, logContext,
      });
    case "ORDER_ADMISSION_CONFLICT": {
      const current = context.current;
      // Unread, the order may hold another authorization that can still
      // settle, so the caller reconciles before it signs anything.
      if (current === "unread") {
        return standardRailError("PAYMENT_PENDING_RECONCILIATION", {
          phase: "payment_validation",
          message: "The payment claim was refused and the order could not be read again",
          cause: error,
          logContext,
        });
      }
      if (current?.paymentPayloadHash && current.paymentPayloadHash !== context.paymentPayloadHash) {
        return standardRailError("PAYMENT_IDENTIFIER_CONFLICT", {
          field: "payment-identifier", cause: error, logContext,
        });
      }
      // Unclaimed and no longer claimable: it expired, at the database clock.
      return standardRailError("CHALLENGE_EXPIRED", {
        message: "This challenge can no longer be paid", cause: error, logContext,
      });
    }
    default:
      return error;
  }
}

// The database's own message: SQLSTATE texts and node-postgres connection
// messages carry no statement parameters.
function causeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
