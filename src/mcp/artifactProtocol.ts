import { mcpError, mcpJson, type McpToolResult } from "./util.js";

export interface ArtifactCapability {
  signature: string;
  authorization: Record<string, unknown>;
}

interface ArtifactChallenge {
  authorization: Record<string, unknown>;
  eip712TypedData: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export function extractChallenge(body: unknown): ArtifactChallenge | null {
  const challenge = asRecord(asRecord(body)?.capabilityChallenge);
  const authorization = asRecord(challenge?.authorization);
  const eip712TypedData = asRecord(challenge?.eip712TypedData);
  return authorization && eip712TypedData ? { authorization, eip712TypedData } : null;
}

export function mediaType(value: string | null): string | null {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase();
  return type || null;
}

export function parseFilename(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return sanitizeFilename(decodeURIComponent(encoded));
    } catch {
      return sanitizeFilename(encoded);
    }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
  return plain ? sanitizeFilename(plain) : null;
}

export function sanitizeFilename(value: string): string | null {
  const basename = value.normalize("NFKC").split(/[\\/]/).pop() ?? "";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  const limited = Array.from(cleaned).slice(0, 160).join("");
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(limited)
    ? `_${limited}`
    : limited;
}

export function challengeResponse(
  challenge: ArtifactChallenge,
  taskId: string,
  artifactUrl: string,
  refreshed: boolean,
): McpToolResult {
  // The provider's document challenge is a TaskAccessChallenge whose
  // authorization binds (buyerTokenId, taskId, action, nonce, expiry) — it
  // carries NO resource field, so URL equality can only be enforced when a
  // challenge actually has one. Requiring it unconditionally rejected every
  // legitimate download (agentic run 260723-163533: 30+ mismatches across
  // provably correct URL+taskId pairs). Server-side scoping still holds:
  // the provider binds the token audience to the minting transaction +
  // buyer, and document tokens are strictly one-time.
  if (
    challenge.authorization.taskId !== taskId ||
    challenge.authorization.action !== "document-download" ||
    (challenge.authorization.resource !== undefined &&
      challenge.authorization.resource !== artifactUrl)
  ) {
    const boundTask = challenge.authorization.taskId;
    return mcpError({
      code: "ARTIFACT_CHALLENGE_MISMATCH",
      message:
        typeof boundTask === "string" && boundTask !== taskId
          ? `The artifact challenge for this URL is bound to taskId '${boundTask}' ` +
            `(the task whose response minted the URL), not '${taskId}'. Re-call ` +
            "with that taskId — do not pass a contextId, documentId, or another " +
            "task's id."
          : "The artifact challenge is not bound to the requested taskId, URL, " +
            'and action="document-download". Refusing to request a signature.',
    });
  }
  return mcpJson({
    requiresSignature: true,
    taskId,
    capabilityChallenge: challenge,
    authorization: challenge.authorization,
    eip712TypedData: challenge.eip712TypedData,
    hint: refreshed
      ? "The previous capability was rejected or expired. Sign this fresh " +
        "eip712TypedData, then retry with capability: { signature, " +
        "authorization } using this authorization verbatim."
      : "Sign eip712TypedData with the buyer agent wallet, then retry with " +
        "capability: { signature, authorization } using this authorization " +
        "verbatim.",
  });
}

export function validateCapability(
  capability: ArtifactCapability,
  taskId: string,
  artifactUrl: string,
): McpToolResult | null {
  if (
    capability.authorization.taskId === taskId &&
    capability.authorization.action === "document-download" &&
    // TaskAccess-shaped authorizations have no resource binding — enforce
    // URL equality only when the signed authorization carries one.
    (capability.authorization.resource === undefined ||
      capability.authorization.resource === artifactUrl)
  ) {
    return null;
  }
  return mcpError({
    code: "ARTIFACT_CAPABILITY_MISMATCH",
    message:
      "capability.authorization must match this taskId and exact URL and use " +
      'action="document-download". Sign the challenge returned for this URL.',
    recoverable: true,
    next_action: "Call daski_fetch_artifact without capability to obtain a fresh challenge.",
  });
}
