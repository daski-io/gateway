// Named mappings for the provider's JSON-RPC app-level error codes
// (mirrors daski-provider core/a2a/jsonrpc.ts DASKI_ERR, -32100..-32111,
// plus the JSON-RPC standard codes). Before this map existed the gateway
// wrapped every provider RPC error as a generic `PROVIDER_ERROR` with the
// real signal buried in details.rpcCode — the 2026-07-25 review showed
// agents recovering only by digging the -32107 capability challenge out of
// nested details. A typed top-level `code` is the contract; `rpcCode`
// stays in details for exactness.

interface MappedRpcError {
  code: string;
  recoverable?: boolean;
  nextAction?: string;
}

const KNOWN_RPC_ERRORS: Record<number, MappedRpcError> = {
  [-32100]: { code: "SERVICE_NOT_FOUND" },
  [-32101]: { code: "SERVICE_OWNERSHIP_MISMATCH" },
  [-32102]: { code: "CHAIN_MISMATCH" },
  [-32103]: { code: "PAYMENT_VERIFICATION_FAILED" },
  [-32104]: { code: "ASSET_NOT_OWNED" },
  [-32105]: { code: "FULFILLMENT_FAILED" },
  [-32106]: {
    code: "TASK_NOT_IN_INPUT_REQUIRED",
    recoverable: true,
    nextAction:
      "Poll daski_get_task_status first — only a task currently in " +
      "input-required accepts a corrected-input resubmit.",
  },
  [-32107]: {
    code: "CAPABILITY_REQUIRED",
    recoverable: true,
    nextAction:
      "This is an expected authorization step, not a failure. Sign the " +
      "capability challenge in details.data.capabilityChallenge (or a " +
      "task_access_challenge you already hold for this exact taskId and " +
      "action) and retry the SAME call with `capability` added.",
  },
  [-32108]: {
    code: "CAPABILITY_REJECTED",
    recoverable: true,
    nextAction:
      "The capability did not verify for this task/action. Request and " +
      "sign a FRESH challenge for THIS taskId and action — capabilities " +
      "never transfer across tasks or actions.",
  },
  [-32109]: {
    code: "ENVELOPE_AUTH_REQUIRED",
    recoverable: true,
    nextAction:
      "Call daski_submit_task WITHOUT envelopeAuth first to receive the " +
      "envelope signing material, sign it exactly, then retry with " +
      "envelopeAuth.",
  },
  [-32110]: {
    code: "ENVELOPE_AUTH_REJECTED",
    recoverable: true,
    nextAction:
      "The signed envelope did not match this request — the bytes you " +
      "send must equal the bytes you signed. Request a fresh envelope " +
      "(first-call form) and re-sign; never alter serviceArgs or any " +
      "authorization field after signing.",
  },
  [-32111]: {
    code: "PAYMENT_INSUFFICIENT",
    nextAction:
      "The payment bound to this call does not cover the quoted amount. " +
      "Verify the paymentId/serviceRef pairing and the settled amount " +
      "before retrying — do not re-pay without checking.",
  },
  [-32600]: { code: "INVALID_REQUEST" },
  [-32601]: { code: "METHOD_NOT_FOUND" },
  [-32602]: {
    code: "INVALID_PARAMS",
    recoverable: true,
    nextAction:
      "The provider names the offending parameter in the message — fix " +
      "that exact field and retry.",
  },
  [-32603]: { code: "PROVIDER_INTERNAL_ERROR" },
};

/**
 * Maps a provider JSON-RPC error code to a stable named gateway code.
 * Returns null for unknown codes — callers fall back to PROVIDER_ERROR.
 */
export function mapProviderRpcError(
  rpcCode: number | undefined,
): MappedRpcError | null {
  if (typeof rpcCode !== "number") return null;
  return KNOWN_RPC_ERRORS[rpcCode] ?? null;
}
