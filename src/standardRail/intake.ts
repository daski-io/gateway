import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { canonicalHash } from "./canonical.js";
import { discardResponseBody, readBoundedJsonResponse } from "./boundedJson.js";
import { assertBoundedJsonValue, REQUEST_JSON_BUDGET, RESPONSE_JSON_BUDGET } from "./jsonBounds.js";
import { signEnvelope } from "./signing.js";
import { standardRailError } from "./errors.js";
import type { StandardListing } from "./types.js";

/** Fetch signed intake data through the provider's already admitted quote endpoint. */
export async function getIntakeRequirements(args: {
  listing: StandardListing; request: Record<string, unknown>;
  environment: string; chainId: number; privateKey: Hex; timeoutMs: number;
  fetchProvider: (endpoint: string, init: RequestInit) => Promise<Response>;
}): Promise<Record<string, unknown>> {
  try {
    assertBoundedJsonValue(args.request, REQUEST_JSON_BUDGET, "Intake request");
    if (!args.request || typeof args.request !== "object" || Array.isArray(args.request)) throw new Error("Invalid request");
  } catch {
    throw standardRailError("REQUEST_SCHEMA_INVALID", { field: "request" });
  }
  try {
    const listing = args.listing;
    const now = Math.floor(Date.now() / 1_000);
    const requestHash = canonicalHash(args.request);
    const envelope = await signEnvelope({
      artifactType: "ProviderIntakeRequestV1", environment: args.environment, chainId: args.chainId,
      audience: listing.providerControlProfile.payload.providerAudience, signerKeyId: "gateway-dispatch",
      privateKey: args.privateKey, issuedAt: now, validBefore: now + 60,
      payload: { outcomeId: listing.commitment.payload.outcomeId, listingManifestHash: listing.runtimeCommitmentHash,
        requestHash, request: args.request },
    });
    const response = await args.fetchProvider(listing.providerControlProfile.payload.quoteUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: envelope }),
      redirect: "error", signal: AbortSignal.timeout(Math.min(args.timeoutMs, listing.providerControlProfile.payload.timeoutMs)),
    });
    if (!response.ok) { await discardResponseBody(response); throw new Error("Intake unavailable"); }
    const value = await readBoundedJsonResponse(response, Math.min(262_144, listing.providerControlProfile.payload.maxResponseBytes));
    assertBoundedJsonValue(value, RESPONSE_JSON_BUDGET, "Intake response");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intake response");
    const result = value as Record<string, unknown>;
    const keys = ["outcomeId", "listingManifestHash", "requestHash", "requestSchema", "requiredFields",
      "selectorsRequired", "normalizedSelectors", "fieldErrors", "supported", "issuedAt", "validBefore", "signature"];
    if (Object.keys(result).sort().join() !== keys.sort().join() ||
        result.outcomeId !== listing.commitment.payload.outcomeId || result.listingManifestHash !== listing.runtimeCommitmentHash ||
        result.requestHash !== requestHash || typeof result.signature !== "string" ||
        !Number.isSafeInteger(result.issuedAt) || Number(result.issuedAt) > now + 30 || Number(result.issuedAt) < now - 120 ||
        !Number.isSafeInteger(result.validBefore) || Number(result.validBefore) <= now || Number(result.validBefore) > now + 120 ||
        !Array.isArray(result.selectorsRequired) || !result.selectorsRequired.every((entry) => typeof entry === "string") ||
        !Array.isArray(result.fieldErrors) || result.fieldErrors.length > 32 ||
        !result.fieldErrors.every((entry) => entry && typeof entry === "object" &&
          ["path", "rule", "message"].every((key) => typeof entry[key] === "string")) ||
        ![true, false, null].includes(result.supported as boolean | null)) throw new Error("Intake binding is invalid");
    for (const key of ["requestSchema", "requiredFields", "normalizedSelectors"]) {
      if (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key])) throw new Error("Invalid intake contract");
    }
    // The provider can add contextual requirements, but the published base schema stays authoritative.
    if (canonicalHash(result.requestSchema) !== canonicalHash(listing.requestSchema)) throw new Error("Intake schema mismatch");
    const { signature, ...payload } = result;
    const signer = await recoverMessageAddress({ message: { raw: canonicalHash(payload) }, signature: signature as Hex });
    if (getAddress(signer) !== getAddress(listing.commitment.payload.providerAuthorityKey)) throw new Error("Invalid intake signer");
    return { providerAgentId: listing.commitment.payload.providerAgentId, ...payload };
  } catch (error) {
    throw standardRailError("PROVIDER_INTAKE_UNAVAILABLE", { cause: error });
  }
}
