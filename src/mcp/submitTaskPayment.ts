import { computeRequestHash } from "../auth/envelope.js";
import type { Queries } from "../db/queries.js";
import type { Hex, StoredChallenge } from "../types.js";
import type { SubmitTaskArgs } from "./submitTaskTypes.js";
import { mcpError, type McpToolResult } from "./util.js";

type PaymentContextResult =
  | {
      ok: true;
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

/**
 * Restores and validates the gateway payment binding before provider dispatch.
 * The input is mutable so omitted signed-retry routing fields can be restored.
 */
export async function resolveSubmitTaskPayment(
  args: SubmitTaskArgs,
  skillMeta: Record<string, unknown>,
  queries: Queries,
): Promise<PaymentContextResult> {
  if (args.envelopeAuth?.authorization.requestHash) {
    const sentHash = requestHash(args);
    if (!sentHash) {
      return fail("BAD_INPUT", "serviceArgs cannot be canonically hashed");
    }
    if (
      sentHash.toLowerCase() !==
      args.envelopeAuth.authorization.requestHash.toLowerCase()
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
      !paidChallenge ||
      paidChallenge.status !== "paid" ||
      paidChallenge.paymentId === null ||
      paidChallenge.transactionHash === null
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
    args.serviceRef = paidChallenge.serviceRef;
    args.transactionHash = paidChallenge.transactionHash;
  }

  const metaDeclaresGating =
    "paymentRequired" in skillMeta ||
    "requiresAssetOwnership" in skillMeta ||
    "requiresCapability" in skillMeta;
  const requiresEnvelopeAuth = args.taskId
    ? false
    : args.serviceRef !== undefined && args.transactionHash !== undefined
      ? true
      : metaDeclaresGating
        ? skillMeta.paymentRequired === true ||
          skillMeta.requiresAssetOwnership === true ||
          skillMeta.requiresCapability === true
        : args.paymentId !== "0" && args.paymentId !== "";

  if (!args.serviceRef || args.taskId) {
    return { ok: true, paidChallenge, requiresEnvelopeAuth };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(args.serviceRef)) {
    return fail(
      "BAD_INPUT",
      "serviceRef must be a 0x-prefixed 32-byte hex value.",
    );
  }
  if (!paidChallenge) {
    try {
      paidChallenge = await queries.getChallengeByRef(
        args.serviceRef.toLowerCase() as Hex,
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
    paidChallenge.status !== "paid" ||
    paidChallenge.paymentId === null ||
    paidChallenge.transactionHash === null
  ) {
    return fail(
      "PAYMENT_NOT_SETTLED",
      "The payment challenge has not completed settlement.",
      { recoverable: true },
    );
  }
  const bindingMismatch =
    paidChallenge.skillId !== args.skillId ||
    paidChallenge.paymentId.toString() !== args.paymentId ||
    paidChallenge.providerA2AUrl !== args.providerA2AUrl ||
    !args.transactionHash ||
    paidChallenge.transactionHash.toLowerCase() !==
      args.transactionHash.toLowerCase();
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
  const committedRequestHash = requestHash(args);
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
  return { ok: true, paidChallenge, requiresEnvelopeAuth };
}
