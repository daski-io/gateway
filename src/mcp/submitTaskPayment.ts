import { computeRequestHash } from "../auth/envelope.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import { mcpError, type McpToolResult } from "./util.js";

type PaymentContextResult =
  | {
      ok: true;
      args: SubmitTaskArgs;
      paidChallenge: StoredChallenge | null;
      requiresEnvelopeAuth: boolean;
    }
  | { ok: false; result: McpToolResult };

function fail(
  code: string,
  message: string,
  extra: { recoverable?: boolean; next_action?: string } = {},
): PaymentContextResult {
  return { ok: false, result: mcpError({ code, message, ...extra }) };
}

function requestHash(args: SubmitTaskArgs): Hex | null {
  try {
    return computeRequestHash(args.serviceArgs ?? {});
  } catch {
    return null;
  }
}

type SettledChallenge = StoredChallenge & {
  paymentId: bigint;
  transactionHash: Hex;
};

function isSettled(
  challenge: StoredChallenge | null,
): challenge is SettledChallenge {
  return Boolean(
    challenge &&
      challenge.settlementState === "paid" &&
      challenge.paymentId !== null &&
      challenge.transactionHash !== null,
  );
}

function envelopeRequired(
  args: SubmitTaskArgs,
  skillMeta: Record<string, unknown>,
): boolean {
  if (args.taskId) return false;
  if (args.serviceRef && args.transactionHash) return true;
  const declaresGating =
    "paymentRequired" in skillMeta ||
    "requiresAssetOwnership" in skillMeta ||
    "requiresCapability" in skillMeta;
  if (!declaresGating) return args.paymentId !== "0" && args.paymentId !== "";
  return (
    skillMeta.paymentRequired === true ||
    skillMeta.requiresAssetOwnership === true ||
    skillMeta.requiresCapability === true
  );
}

/**
 * Restores and validates the gateway payment binding before provider dispatch.
 * Omitted signed-retry routing fields are restored into a normalized copy.
 */
export async function resolveSubmitTaskPayment(
  args: SubmitTaskArgs,
  skillMeta: Record<string, unknown>,
  queries: Queries,
): Promise<PaymentContextResult> {
  let normalizedArgs = { ...args };

  // Flow-state restore (migration 017): a continuation call may omit
  // serviceArgs entirely — the canonical args the quote committed to are
  // restored from the challenge row. The envelope/quote hash checks below
  // still run against the restored bytes, so what was signed is exactly
  // what executes.
  if (
    normalizedArgs.serviceArgs === undefined &&
    normalizedArgs.serviceRef &&
    /^0x[0-9a-fA-F]{64}$/.test(normalizedArgs.serviceRef)
  ) {
    try {
      const flow = await queries.getChallengeByRef(
        normalizedArgs.serviceRef.toLowerCase() as Hex,
      );
      if (flow?.serviceArgs) {
        normalizedArgs = { ...normalizedArgs, serviceArgs: flow.serviceArgs };
      }
    } catch {
      // Restore is best-effort; the explicit-args contract still applies.
    }
  }

  if (normalizedArgs.envelopeAuth?.authorization.requestHash) {
    const sentHash = requestHash(normalizedArgs);
    if (!sentHash) {
      return fail("BAD_INPUT", "serviceArgs cannot be canonically hashed");
    }
    if (
      sentHash.toLowerCase() !==
      normalizedArgs.envelopeAuth.authorization.requestHash.toLowerCase()
    ) {
      return fail(
        "REQUEST_HASH_MISMATCH",
        "serviceArgs do not hash to envelopeAuth.authorization.requestHash. " +
          "Nothing was sent to the provider; resend the exact signed body or " +
          "start a fresh envelope challenge.",
        {
          recoverable: true,
          next_action:
            "Retry with the original serviceArgs unchanged, or request a " +
            "new envelope challenge for a different body.",
        },
      );
    }
  }

  let paidChallenge: StoredChallenge | null = null;
  const isPaidSignedRetry =
    !args.taskId &&
    Boolean(args.envelopeAuth) &&
    skillMeta.paymentRequired === true &&
    (!args.serviceRef || !args.transactionHash);

  if (isPaidSignedRetry) {
    if (!/^[1-9][0-9]*$/.test(args.paymentId)) {
      return fail(
        "PAYMENT_ID_INVALID",
        "A paid signed retry needs the positive decimal paymentId returned " +
          "by settlement. No task was dispatched.",
      );
    }
    try {
      paidChallenge = await queries.getChallengeByPaymentId(
        BigInt(args.paymentId),
      );
    } catch {
      return fail(
        "QUOTE_LOOKUP_FAILED",
        "The gateway could not restore serviceRef and transactionHash from " +
          "this settled payment. No task was dispatched.",
        {
          recoverable: true,
          next_action:
            "Re-call with the same envelopeAuth/messageId plus the original " +
            "serviceRef and transactionHash.",
        },
      );
    }
    if (
      !isSettled(paidChallenge)
    ) {
      return fail(
        "PAID_PATH_CREDENTIALS_NOT_FOUND",
        "No settled gateway payment matches this paymentId. No task was dispatched.",
        {
          recoverable: true,
          next_action:
            "Re-call with the same envelopeAuth/messageId plus the original " +
            "serviceRef and transactionHash.",
        },
      );
    }
    const restoredBindingMismatch =
      paidChallenge.skillId !== args.skillId ||
      paidChallenge.providerA2AUrl !== args.providerA2AUrl ||
      paidChallenge.buyerTokenId.toString() !==
        args.envelopeAuth!.authorization.buyerTokenId ||
      (args.serviceRef !== undefined &&
        paidChallenge.serviceRef.toLowerCase() !== args.serviceRef.toLowerCase()) ||
      (args.transactionHash !== undefined &&
        paidChallenge.transactionHash.toLowerCase() !==
          args.transactionHash.toLowerCase());
    if (restoredBindingMismatch) {
      return fail(
        "PAYMENT_BINDING_MISMATCH",
        "The signed retry conflicts with the settled payment binding. " +
          "No task was dispatched.",
      );
    }
    normalizedArgs = {
      ...normalizedArgs,
      serviceRef: paidChallenge.serviceRef,
      transactionHash: paidChallenge.transactionHash!,
    };
  }

  const requiresEnvelopeAuth = envelopeRequired(normalizedArgs, skillMeta);

  if (!normalizedArgs.serviceRef || normalizedArgs.taskId) {
    return {
      ok: true,
      args: normalizedArgs,
      paidChallenge,
      requiresEnvelopeAuth,
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedArgs.serviceRef)) {
    return fail(
      "BAD_INPUT",
      "serviceRef must be a 0x-prefixed 32-byte hex value.",
    );
  }
  if (!paidChallenge) {
    try {
      paidChallenge = await queries.getChallengeByRef(
        normalizedArgs.serviceRef.toLowerCase() as Hex,
      );
    } catch {
      return fail(
        "QUOTE_LOOKUP_FAILED",
        "The gateway could not load the settled quote credentials. No task was dispatched.",
        {
          recoverable: true,
          next_action: "Retry daski_submit_task with the same arguments.",
        },
      );
    }
  }
  if (!paidChallenge) {
    return fail(
      "PAYMENT_CHALLENGE_NOT_FOUND",
      "No gateway payment challenge matches this serviceRef. No task was dispatched.",
    );
  }
  if (
    !isSettled(paidChallenge)
  ) {
    return fail(
      "PAYMENT_NOT_SETTLED",
      "The payment challenge has not completed settlement.",
      { recoverable: true },
    );
  }
  const bindingMismatch =
    paidChallenge.skillId !== normalizedArgs.skillId ||
    paidChallenge.paymentId!.toString() !== normalizedArgs.paymentId ||
    paidChallenge.providerA2AUrl !== normalizedArgs.providerA2AUrl ||
    !normalizedArgs.transactionHash ||
    paidChallenge.transactionHash.toLowerCase() !==
      normalizedArgs.transactionHash.toLowerCase();
  if (bindingMismatch) {
    return fail(
      "PAYMENT_BINDING_MISMATCH",
      "serviceRef, paymentId, transactionHash, skillId, and providerA2AUrl " +
        "must all describe the same settled challenge. No task was dispatched.",
    );
  }
  if (
    !paidChallenge.quoteId ||
    !paidChallenge.quoteSignature ||
    !paidChallenge.quoteRequestHash
  ) {
    return fail(
      "QUOTE_CREDENTIALS_MISSING",
      "The settled challenge has no complete provider quote commitment.",
    );
  }
  const committedRequestHash = requestHash(normalizedArgs);
  if (!committedRequestHash) {
    return fail("BAD_INPUT", "serviceArgs cannot be canonically hashed");
  }
  if (
    committedRequestHash.toLowerCase() !==
    paidChallenge.quoteRequestHash.toLowerCase()
  ) {
    return fail(
      "QUOTE_REQUEST_MISMATCH",
      "serviceArgs differ from the request committed by the provider quote.",
    );
  }
  return {
    ok: true,
    args: normalizedArgs,
    paidChallenge,
    requiresEnvelopeAuth,
  };
}
