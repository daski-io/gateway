import { discardResponseBody, readBoundedJsonResponse } from "./boundedJson.js";
import { standardRailError, type StandardRailError, type StandardRailErrorCode } from "./errors.js";

const REFUSAL_BODY_BYTES = 1_024;

/** The Retry-After a buyer receives when the provider cannot serve an order action yet. */
export const LIFECYCLE_RETRY_AFTER_SECONDS = 10;

/**
 * The provider refusals named to the buyer: an exact status and a body whose
 * only key is `error` with exactly this value. Only an artifact read can be
 * unavailable; any lifecycle action can be unsupported, conflict with the
 * content its identity already bound, or meet a provider that cannot serve it
 * yet. The provider controls no other part of the buyer's answer.
 */
const NAMED_REFUSALS: ReadonlyArray<{
  status: number;
  error: string;
  code: StandardRailErrorCode;
  actions?: readonly string[];
}> = [
  { status: 409, error: "artifact_unavailable", code: "ARTIFACT_NOT_AVAILABLE", actions: ["artifact"] },
  { status: 409, error: "unsupported_action", code: "ORDER_ACTION_UNSUPPORTED" },
  { status: 409, error: "action_conflict", code: "ORDER_ACTION_CONFLICT" },
  { status: 503, error: "lifecycle_unavailable", code: "PROVIDER_LIFECYCLE_UNAVAILABLE" },
];

/**
 * The public error for a provider lifecycle refusal. Any other status or body,
 * including an edge page, an extra key or an oversized body, stays an internal
 * error. A read capability is reused on retry; a signed action has already
 * consumed its authorization, so only a fresh one can retry it.
 */
export async function providerLifecycleRefusal(
  action: string,
  response: Response,
  options: { readCapability?: boolean } = {},
): Promise<StandardRailError> {
  const candidates = NAMED_REFUSALS.filter((refusal) =>
    refusal.status === response.status && (!refusal.actions || refusal.actions.includes(action)));
  if (candidates.length === 0) {
    await discardResponseBody(response);
  } else {
    try {
      const body = await readBoundedJsonResponse(response, REFUSAL_BODY_BYTES);
      const named = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1
        ? candidates.find((refusal) => (body as Record<string, unknown>).error === refusal.error)
        : undefined;
      if (named) {
        return standardRailError(named.code, named.code === "PROVIDER_LIFECYCLE_UNAVAILABLE" && options.readCapability
          ? { requiresNewSignature: false } : {});
      }
    } catch {
      // An unreadable refusal is not evidence of anything; it stays internal.
    }
  }
  return standardRailError("INTERNAL_ERROR", { phase: "dispatch", internalMessage: "PROVIDER_LIFECYCLE_REJECTED" });
}
