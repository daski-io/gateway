import { canonicalHash } from "./canonical.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The signed lifecycle response always retains the provider task envelope.
 * A paid contract may describe that task or the data in its artifacts. Select
 * only by the immutable listing schema, never by the current provider card.
 */
export function projectContractResult(schema: Record<string, unknown>, result: unknown): unknown {
  const properties = schema.properties;
  if (!object(properties) || ("id" in properties && "status" in properties) ||
      !object(result) || typeof result.id !== "string" || !object(result.status) ||
      !Array.isArray(result.artifacts)) return result;
  const projected: Record<string, unknown> = {};
  let found = false;
  let mailboxRenewed = false;
  for (const artifact of result.artifacts) {
    if (!object(artifact) || !Array.isArray(artifact.parts)) throw new Error("Invalid provider artifact envelope");
    for (const part of artifact.parts) {
      if (!object(part) || part.kind !== "data") continue;
      if (!object(part.data)) throw new Error("Invalid provider artifact data");
      if (artifact.name === "mailbox_renewed" && typeof part.data.address === "string" &&
          typeof part.data.expiresAt === "string" && typeof part.data.restored === "boolean") mailboxRenewed = true;
      for (const [key, value] of Object.entries(part.data)) {
        if (!Object.hasOwn(properties, key)) continue;
        // The original transfer-result contract declares an array; the provider
        // historically stored its single instruction as a string.
        const definition = properties[key];
        const normalized = key === "nextSteps" && object(definition) &&
          definition.type === "array" && typeof value === "string" ? [value] : value;
        if (Object.hasOwn(projected, key) && canonicalHash(projected[key]) !== canonicalHash(normalized))
          throw new Error("Conflicting provider result artifacts");
        projected[key] = normalized;
        found = true;
      }
    }
  }
  // A lifecycle task already signs its terminal state. Flat lifecycle contracts
  // expose that same state as a string beside their artifact fields.
  if (found && !Object.hasOwn(projected, "status") && object(properties.status) &&
      properties.status.type === "string" && result.status.state === "TASK_STATE_COMPLETED")
    projected.status = "completed";
  // The legacy mailbox renewal artifact records successful renewal by its
  // signed artifact type; restored is a separate sending-reactivation flag.
  if (mailboxRenewed && result.status.state === "TASK_STATE_COMPLETED" &&
      !Object.hasOwn(projected, "renewed") && object(properties.renewed) && properties.renewed.type === "boolean")
    projected.renewed = true;
  // Missing required fields remain a schema failure; never invent result data.
  return found ? projected : result;
}
