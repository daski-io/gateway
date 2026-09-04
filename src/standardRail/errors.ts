import { randomUUID } from "node:crypto";
import { logger } from "../util/logger.js";
import { RequestSchemaError } from "./schema.js";

export const STANDARD_RAIL_PHASES = [
  "request_validation",
  "quoting",
  "challenge",
  "payment_validation",
  "facilitator_verify",
  "facilitator_settle",
  "dispatch",
  "lifecycle_auth",
  "internal",
] as const;

export type StandardRailPhase = typeof STANDARD_RAIL_PHASES[number];

export type StandardRailErrorCode =
  | "REQUEST_SCHEMA_INVALID"
  | "OUTCOME_NOT_FOUND"
  | "LISTING_SUPERSEDED"
  | "PROVIDER_QUOTE_REJECTED"
  | "PROVIDER_QUOTE_UNAVAILABLE"
  | "CHALLENGE_EXPIRED"
  | "PAYMENT_VERSION_UNSUPPORTED"
  | "EXTENSION_MISMATCH"
  | "EXTENSION_REQUIRED_MISSING"
  | "PAYLOAD_SHAPE_INVALID"
  | "AUTHORIZATION_SHAPE_INVALID"
  | "AUTHORIZATION_MISMATCH"
  | "AUTHORIZATION_WINDOW"
  | "SELF_PURCHASE_FORBIDDEN"
  | "NONCE_RECIPE_MISMATCH"
  | "SIGNATURE_INVALID"
  | "FACILITATOR_REJECTED"
  | "PAYMENT_PENDING_RECONCILIATION"
  | "PAYMENT_IDENTIFIER_UNKNOWN"
  | "PAYMENT_IDENTIFIER_CONFLICT"
  | "WALLET_AUTHORIZATION_INVALID"
  | "INTERNAL_ERROR";

export interface StandardRailFieldError {
  path: string;
  rule: string;
  message: string;
  allowedValues?: readonly string[];
}

interface ErrorDefaults {
  status: number;
  message: string;
  phase: StandardRailPhase;
  retryable: boolean;
  requiresNewSignature: boolean;
  paymentMayHaveSettled: boolean;
  nextAction: string;
}

const DEFAULTS: Record<StandardRailErrorCode, ErrorDefaults> = {
  REQUEST_SCHEMA_INVALID: {
    status: 400,
    message: "The request does not match the required schema",
    phase: "request_validation",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Correct the listed request fields, then retry the same operation.",
  },
  OUTCOME_NOT_FOUND: {
    status: 404,
    message: "Outcome not found",
    phase: "request_validation",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Verify providerAgentId and outcomeId with daski_list_outcomes, then retry.",
  },
  LISTING_SUPERSEDED: {
    status: 409,
    message: "The listing changed after this order was drafted",
    phase: "challenge",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Fetch the current outcome and request a new payment challenge before signing again.",
  },
  PROVIDER_QUOTE_REJECTED: {
    status: 409,
    message: "The provider declined to quote this request",
    phase: "quoting",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Revise the request using fieldErrors when present, then request a new quote.",
  },
  PROVIDER_QUOTE_UNAVAILABLE: {
    status: 502,
    message: "The provider did not return a usable quote",
    phase: "quoting",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Retry later; do not create or sign a payment until quoting succeeds.",
  },
  CHALLENGE_EXPIRED: {
    status: 409,
    message: "The challenge expired before payment could start (formerly OUTCOME_OFFER_EXPIRED)",
    phase: "challenge",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Request a fresh payment challenge and sign only the new sign request.",
  },
  PAYMENT_VERSION_UNSUPPORTED: {
    status: 400,
    message: "Only x402 V2 payments are supported",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Build a new x402 V2 payment from a fresh challenge.",
  },
  EXTENSION_MISMATCH: {
    status: 400,
    message: "A payment extension differs from the issued challenge",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Echo the issued extensions exactly, excluding daski-sign-request, and sign again.",
  },
  EXTENSION_REQUIRED_MISSING: {
    status: 400,
    message: "A required payment extension is missing",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Copy every required extension from a fresh challenge and sign again.",
  },
  PAYLOAD_SHAPE_INVALID: {
    status: 400,
    message: "The Exact-EVM payment payload shape is invalid",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Use submitAs.paymentPayload from a fresh sign-ready challenge without adding fields.",
  },
  AUTHORIZATION_SHAPE_INVALID: {
    status: 400,
    message: "The EIP-3009 authorization shape is invalid",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Sign the challenge eip712.message exactly as supplied, then submit it unchanged.",
  },
  AUTHORIZATION_MISMATCH: {
    status: 400,
    message: "The EIP-3009 authorization does not match the challenge",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Request a fresh challenge and sign its complete eip712 payload without edits.",
  },
  AUTHORIZATION_WINDOW: {
    status: 400,
    message: "The EIP-3009 authorization timing window is outside the accepted bounds",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Use the server-provided timing values from a fresh sign request and sign again.",
  },
  SELF_PURCHASE_FORBIDDEN: {
    status: 403,
    message: "Known self-purchase is forbidden",
    phase: "payment_validation",
    retryable: false,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Use an eligible payer wallet independent of provider and marketplace roles.",
  },
  NONCE_RECIPE_MISMATCH: {
    status: 400,
    message: "The authorization nonce does not match the Daski order-binding recipe",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Recompute the nonce from expected.recipeInputs or sign the provided eip712 message.",
  },
  SIGNATURE_INVALID: {
    status: 400,
    message: "The EIP-3009 signature is invalid",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Use the configured payer signer to sign a fresh challenge without altering it.",
  },
  FACILITATOR_REJECTED: {
    status: 422,
    message: "The external facilitator rejected the payment",
    phase: "facilitator_verify",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Correct verify failures; after settle, reconcile before re-signing.",
  },
  PAYMENT_PENDING_RECONCILIATION: {
    status: 409,
    message: "Settlement was submitted but its outcome is not yet confirmed",
    phase: "facilitator_settle",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: true,
    nextAction: "Reconcile by paymentIdentifier before any retry; never create a new signature yet.",
  },
  // No challenge was ever issued under the presented identifier, so nothing
  // can have settled under it. A client that mints its own identifier instead
  // of carrying payment-identifier.info.id from the challenge lands here
  // (@daski/pay 0.1.0 and 0.1.1 did, 2026-09-03/04); before this code existed
  // it was reported as a conflict with paymentMayHaveSettled: true, which sent
  // agents into a reconciliation loop over a payment that never existed.
  PAYMENT_IDENTIFIER_UNKNOWN: {
    status: 400,
    message: "The payment identifier was not issued by this gateway",
    phase: "payment_validation",
    retryable: true,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction:
      "Carry payment-identifier.info.id exactly as the challenge issued it; " +
      "if that challenge is gone, request a fresh one and sign its message.",
  },
  PAYMENT_IDENTIFIER_CONFLICT: {
    status: 409,
    message: "The payment identifier is already bound to a different authorization",
    phase: "payment_validation",
    retryable: false,
    requiresNewSignature: false,
    paymentMayHaveSettled: true,
    nextAction: "Look up the original order by paymentIdentifier; do not re-sign.",
  },
  WALLET_AUTHORIZATION_INVALID: {
    status: 401,
    message: "Wallet authorization rejected",
    phase: "lifecycle_auth",
    retryable: true,
    requiresNewSignature: true,
    paymentMayHaveSettled: false,
    nextAction: "Request a fresh challenge; for read access, re-run daski_get_order_access.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "Internal server error",
    phase: "internal",
    retryable: false,
    requiresNewSignature: false,
    paymentMayHaveSettled: false,
    nextAction: "Stop and report the correlationId; do not improvise a payment retry.",
  },
};

export interface StandardRailErrorOptions {
  status?: number;
  message?: string;
  phase?: StandardRailPhase;
  field?: string;
  retryable?: boolean;
  requiresNewSignature?: boolean;
  paymentMayHaveSettled?: boolean;
  serverTime?: number;
  expected?: Record<string, unknown>;
  fieldErrors?: readonly StandardRailFieldError[];
  nextAction?: string;
  internalMessage?: string;
  logContext?: Record<string, unknown>;
  cause?: unknown;
  /** Fixed correlation id — wire fixtures only; production ids are random. */
  correlationId?: string;
}

export class StandardRailError extends Error {
  readonly code: StandardRailErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly phase: StandardRailPhase;
  readonly field?: string;
  readonly retryable: boolean;
  readonly requiresNewSignature: boolean;
  readonly paymentMayHaveSettled: boolean;
  readonly serverTime?: number;
  readonly expected?: Record<string, unknown>;
  readonly fieldErrors?: readonly StandardRailFieldError[];
  readonly nextAction: string;
  readonly correlationId: string;
  readonly logContext: Record<string, unknown>;

  constructor(code: StandardRailErrorCode, options: StandardRailErrorOptions = {}) {
    const defaults = DEFAULTS[code];
    super(options.internalMessage ?? options.message ?? defaults.message, { cause: options.cause });
    this.name = "StandardRailError";
    this.code = code;
    this.status = options.status ?? defaults.status;
    this.publicMessage = options.message ?? defaults.message;
    this.phase = options.phase ?? defaults.phase;
    this.field = options.field;
    this.retryable = options.retryable ?? defaults.retryable;
    this.requiresNewSignature = options.requiresNewSignature ?? defaults.requiresNewSignature;
    this.paymentMayHaveSettled = options.paymentMayHaveSettled ?? defaults.paymentMayHaveSettled;
    this.serverTime = options.serverTime;
    this.expected = options.expected;
    this.fieldErrors = options.fieldErrors;
    this.nextAction = options.nextAction ?? defaults.nextAction;
    this.correlationId = options.correlationId ?? randomUUID();
    this.logContext = options.logContext ?? {};
  }
}

export function standardRailError(
  code: StandardRailErrorCode,
  options: StandardRailErrorOptions = {},
): StandardRailError {
  return new StandardRailError(code, options);
}

function requestError(error: RequestSchemaError): StandardRailError {
  return standardRailError("REQUEST_SCHEMA_INVALID", {
    message: error.message,
    fieldErrors: error.details.slice(0, 32).map((detail) => ({
      path: detail.path,
      rule: detail.keyword,
      message: detail.message,
      ...(detail.allowedValues ? { allowedValues: detail.allowedValues } : {}),
    })),
    cause: error,
  });
}

type LegacyFactory = () => StandardRailError;

// Regression bridge for older persisted/recovery paths. Purchase and lifecycle
// code throws StandardRailError directly; this is exact mapping, never regex.
const LEGACY_ERRORS = new Map<string, LegacyFactory>([
  ["OUTCOME_NOT_FOUND", () => standardRailError("OUTCOME_NOT_FOUND")],
  ["LISTING_SUPERSEDED", () => standardRailError("LISTING_SUPERSEDED")],
  ["PROVIDER_QUOTE_REJECTED", () => standardRailError("PROVIDER_QUOTE_REJECTED")],
  ["PROVIDER_QUOTE_UNAVAILABLE", () => standardRailError("PROVIDER_QUOTE_UNAVAILABLE")],
  ["PROVIDER_QUOTE_INVALID", () => standardRailError("PROVIDER_QUOTE_UNAVAILABLE")],
  ["PROVIDER_QUOTE_SIGNATURE_INVALID", () => standardRailError("PROVIDER_QUOTE_UNAVAILABLE")],
  ["PROVIDER_QUOTE_NOT_RELEASABLE", () => standardRailError("PROVIDER_QUOTE_UNAVAILABLE")],
  ["OUTCOME_OFFER_EXPIRED", () => standardRailError("CHALLENGE_EXPIRED")],
  ["Unsupported payment version or extension", () => standardRailError("PAYMENT_VERSION_UNSUPPORTED")],
  ["Payment payload has an open shape", () => standardRailError("PAYLOAD_SHAPE_INVALID")],
  ["Unsupported Exact-EVM payload field", () => standardRailError("PAYLOAD_SHAPE_INVALID")],
  ["Missing EIP-3009 authorization", () => standardRailError("PAYLOAD_SHAPE_INVALID")],
  ["EIP-3009 authorization has an open shape", () => standardRailError("AUTHORIZATION_SHAPE_INVALID")],
  ["EIP-3009 authorization does not match the challenge", () => standardRailError("AUTHORIZATION_MISMATCH")],
  ["Stock profile requires validAfter=0", () => standardRailError("AUTHORIZATION_WINDOW")],
  ["Recipe authorization lower bound is outside the allowed clock window", () => standardRailError("AUTHORIZATION_WINDOW")],
  ["Known self-purchase is forbidden", () => standardRailError("SELF_PURCHASE_FORBIDDEN")],
  ["Known operational-wallet self-purchase is forbidden", () => standardRailError("SELF_PURCHASE_FORBIDDEN")],
  ["Recipe nonce mismatch", () => standardRailError("NONCE_RECIPE_MISMATCH")],
  ["High-s signatures are forbidden", () => standardRailError("SIGNATURE_INVALID")],
  ["EIP-3009 signature is invalid", () => standardRailError("SIGNATURE_INVALID")],
  ["Changed authorization replay rejected", () => standardRailError("PAYMENT_IDENTIFIER_CONFLICT")],
  ["ACTION_AUTHORIZATION_EXPIRED", () => standardRailError("WALLET_AUTHORIZATION_INVALID")],
  ["ACTION_AUTHORIZATION_BINDING_INVALID", () => standardRailError("WALLET_AUTHORIZATION_INVALID")],
  ["ACTION_AUTHORIZATION_INVALID", () => standardRailError("WALLET_AUTHORIZATION_INVALID")],
  ["ACTION_CHALLENGE_INVALID_OR_REPLAYED", () => standardRailError("WALLET_AUTHORIZATION_INVALID")],
  ["wallet authorization denied", () => standardRailError("WALLET_AUTHORIZATION_INVALID")],
]);

export function asStandardRailError(error: unknown): StandardRailError | null {
  if (error instanceof StandardRailError) return error;
  if (error instanceof RequestSchemaError) return requestError(error);
  if (error instanceof Error) return LEGACY_ERRORS.get(error.message)?.() ?? null;
  return null;
}

export interface StandardRailPublicError {
  code: StandardRailErrorCode;
  message: string;
  phase: StandardRailPhase;
  field?: string;
  retryable: boolean;
  requiresNewSignature: boolean;
  paymentMayHaveSettled: boolean;
  serverTime?: number;
  expected?: Record<string, unknown>;
  fieldErrors?: readonly StandardRailFieldError[];
  docs: string;
  correlationId: string;
}

export function standardRailPublicError(
  error: StandardRailError,
  publicUrl: string,
): StandardRailPublicError {
  return {
    code: error.code,
    message: error.publicMessage,
    phase: error.phase,
    ...(error.field ? { field: error.field } : {}),
    retryable: error.retryable,
    requiresNewSignature: error.requiresNewSignature,
    paymentMayHaveSettled: error.paymentMayHaveSettled,
    ...(error.serverTime === undefined ? {} : { serverTime: error.serverTime }),
    ...(error.expected ? { expected: error.expected } : {}),
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    docs: `${publicUrl.replace(/\/$/, "")}/skills/buy.md#errors`,
    correlationId: error.correlationId,
  };
}

const logged = new WeakSet<StandardRailError>();

export function logStandardRailError(error: StandardRailError): void {
  if (logged.has(error)) return;
  logged.add(error);
  logger.error("standard rail request failed", {
    correlationId: error.correlationId,
    code: error.code,
    phase: error.phase,
    internalMessage: error.message,
    ...error.logContext,
  });
}

/**
 * Postgres could not complete the statement this time and the same request
 * retried unchanged will succeed: serialization_failure and deadlock_detected.
 * Never a client fault, so never a denial.
 */
const TRANSIENT_DATABASE_CODES = new Set(["40001", "40P01"]);

export function isTransientDatabaseError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    TRANSIENT_DATABASE_CODES.has(String((error as { code?: unknown }).code));
}
