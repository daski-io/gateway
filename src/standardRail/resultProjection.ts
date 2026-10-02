import { canonicalHash } from "./canonical.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Metadata emitted by the retained paid handlers, outside their original flat
// schemas. Keep this explicit so projection cannot smuggle an unrelated result
// through a closed contract. All values still face the raw response budget.
const retainedMetadata: Record<string, readonly string[]> = {
  transfer_auth_code: ["expiresAt"],
  domain_transferred_out: ["previousAssetId", "timestamp"],
  mailbox_renewed: ["restored"],
  compliance_filing_details: ["assetId", "documents"],
  dissolution_details: ["assetId", "dissolutionDocumentId", "terminalState"],
  good_standing_details: ["assetId", "documents"],
  ein_details: ["assetId", "documents"],
  amendment_details: ["assetId", "documents", "identifierChanged", "previousEntity"],
  ra_renewal_details: ["assetId", "invoiceSettled"],
  filing_details: ["assetId", "taskId"],
};
const documentArtifacts = new Set(["compliance_filing_document", "dissolution_document",
  "good_standing_certificate", "ein_letter", "amendment_document"]);

function assertRetainedPart(artifact: Record<string, unknown>, part: unknown): asserts part is Record<string, unknown> {
  if (!object(part)) throw new Error("Invalid provider artifact part");
  if (part.kind === "data") return;
  // These exact filing handlers have always attached a passive PDF beside the
  // flat product. Arbitrary new file parts are not part of that paid contract.
  if (part.kind === "file" && typeof artifact.name === "string" && documentArtifacts.has(artifact.name) &&
      object(part.file) && part.file.mimeType === "application/pdf" && typeof part.file.url === "string" &&
      Object.keys(part.file).every(key => ["url", "mimeType"].includes(key))) {
    const url = new URL(part.file.url);
    if (url.protocol === "https:" && !url.username && !url.password) return;
  }
  throw new Error("Undeclared provider artifact part");
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
  if (result.status.state !== "TASK_STATE_COMPLETED") throw new Error("Projected provider task is not completed");
  const projected: Record<string, unknown> = {};
  let found = false;
  let mailboxRenewed = false;
  for (const artifact of result.artifacts) {
    if (!object(artifact) || !Array.isArray(artifact.parts)) throw new Error("Invalid provider artifact envelope");
    for (const part of artifact.parts) {
      assertRetainedPart(artifact, part);
      if (part.kind !== "data") continue;
      if (!object(part.data)) throw new Error("Invalid provider artifact data");
      if (artifact.name === "mailbox_renewed" && typeof part.data.address === "string" &&
          typeof part.data.expiresAt === "string" && typeof part.data.restored === "boolean") mailboxRenewed = true;
      for (const [key, value] of Object.entries(part.data)) {
        if (!Object.hasOwn(properties, key)) {
          const allowed = typeof artifact.name === "string" && retainedMetadata[artifact.name]?.includes(key);
          if (!allowed || !(value === null || ["string", "number", "boolean"].includes(typeof value) ||
              (Array.isArray(value) && value.every(item => typeof item === "string"))))
            throw new Error("Undeclared provider artifact data");
          continue;
        }
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
