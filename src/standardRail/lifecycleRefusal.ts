import { discardResponseBody, readBoundedJsonResponse } from "./boundedJson.js";
import { standardRailError, type StandardRailError } from "./errors.js";

const REFUSAL_BODY_BYTES = 1_024;

/**
 * The public error for a provider lifecycle refusal. Only an artifact read
 * the provider refuses as `artifact_unavailable` is named to the buyer, who
 * is told to read status; every other refusal stays an internal error.
 */
export async function providerLifecycleRefusal(action: string, response: Response): Promise<StandardRailError> {
  if (action === "artifact" && response.status === 409) {
    try {
      const body = await readBoundedJsonResponse(response, REFUSAL_BODY_BYTES);
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 &&
          (body as Record<string, unknown>).error === "artifact_unavailable") {
        return standardRailError("ARTIFACT_NOT_AVAILABLE");
      }
    } catch {
      // An unreadable refusal is not evidence of anything; it stays internal.
    }
  } else {
    await discardResponseBody(response);
  }
  return standardRailError("INTERNAL_ERROR", { phase: "dispatch", internalMessage: "PROVIDER_LIFECYCLE_REJECTED" });
}
