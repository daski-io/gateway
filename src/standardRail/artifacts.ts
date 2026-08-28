import {
  getAddress,
  recoverMessageAddress,
  type Address,
} from "viem";
import { artifactPayloadHash, canonicalHash } from "./canonical.js";
import type {
  AssetActionDefinitionV1,
  SignedEnvelope,
  StandardRailManifest,
} from "./types.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "./schema.js";

export interface ArtifactTrust {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  signers: ReadonlyMap<string, Address>;
  splitterFactoryRuntimeCodeHash: `0x${string}`;
  splitterCreationCodeHash: `0x${string}`;
}

export async function verifyEnvelope<T>(
  envelope: SignedEnvelope<T, number>,
  expectedType: string,
  trust: ArtifactTrust,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const version = Number(expectedType.match(/V([0-9]+)$/)?.[1]);
  if (
    !Number.isSafeInteger(version) ||
    envelope.artifactType !== expectedType ||
    envelope.schemaVersion !== version
  ) {
    throw new Error(`Unsupported ${expectedType} artifact version`);
  }
  if (
    envelope.environment !== trust.environment ||
    envelope.chainId !== trust.chainId ||
    envelope.audience !== trust.gatewayAudience
  ) {
    throw new Error(`${expectedType} artifact domain mismatch`);
  }
  if (envelope.issuedAt > nowSeconds || envelope.validBefore <= nowSeconds) {
    throw new Error(`${expectedType} artifact is outside its validity window`);
  }
  const expectedSigner = trust.signers.get(envelope.signerKeyId);
  if (!expectedSigner) throw new Error(`Unknown artifact signer ${envelope.signerKeyId}`);
  const recovered = await recoverMessageAddress({
    message: { raw: artifactPayloadHash(envelope as unknown as Record<string, unknown> & { signature?: `0x${string}` }) },
    signature: envelope.signature,
  });
  if (getAddress(recovered) !== getAddress(expectedSigner)) {
    throw new Error(`${expectedType} artifact signature is invalid`);
  }
}

function requireClosedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(",")}`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(",")}`);
}

const ENVELOPE_KEYS = [
  "artifactType", "schemaVersion", "environment", "chainId", "audience",
  "signerKeyId", "issuedAt", "validBefore", "payload", "signature",
] as const;

function verifyClosedEnvelope(envelope: SignedEnvelope<unknown, number>, label: string): void {
  requireClosedKeys(envelope as unknown as Record<string, unknown>, ENVELOPE_KEYS, label);
}

export async function verifyStandardRailManifest(
  manifest: StandardRailManifest,
  trust: ArtifactTrust,
): Promise<void> {
  requireClosedKeys(manifest as unknown as Record<string, unknown>, [
    "facilitatorProfile", "railCapabilityRequirements", "activeRailProfile",
    "chainEvidencePolicy",
    "servicingAdmissions",
    "actionCatalogs", "providerControlProfiles",
  ], "standard rail manifest");
  verifyClosedEnvelope(manifest.facilitatorProfile, "facilitator profile envelope");
  verifyClosedEnvelope(manifest.railCapabilityRequirements, "rail capability requirements envelope");
  verifyClosedEnvelope(manifest.activeRailProfile, "active rail profile envelope");
  verifyClosedEnvelope(manifest.chainEvidencePolicy, "chain evidence policy envelope");
  await verifyEnvelope(manifest.facilitatorProfile, "FacilitatorProfileV1", trust);
  await verifyEnvelope(manifest.railCapabilityRequirements, "RailCapabilityRequirementsV1", trust);
  await verifyEnvelope(manifest.activeRailProfile, "ActiveRailProfileV1", trust);
  await verifyEnvelope(manifest.chainEvidencePolicy, "ChainEvidencePolicyV2", trust);
  const controlProfileIds = new Set<string>();
  for (const profile of manifest.providerControlProfiles) {
    verifyClosedEnvelope(profile, "provider control profile envelope");
    await verifyEnvelope(profile, "ProviderControlProfileV1", trust);
    const control = profile.payload;
    requireClosedKeys(control as unknown as Record<string, unknown>, [
      "providerAgentId", "providerAudience", "origin", "quoteUrl", "dispatchUrl",
      "dispatchStatusUrl", "lifecycleUrl", "assetQueryUrl", "assetActionUrl",
      "assetResponseKeyId", "assetResponseKey", "servicingProfileEpoch",
      "tlsPolicy", "workloadAuthentication",
      "maxResponseBytes", "timeoutMs",
    ], "provider control profile payload");
    const origin = new URL(control.origin);
    if (origin.href !== `${origin.origin}/` || origin.protocol !== "https:" || origin.username || origin.password) {
      throw new Error("Provider control profile origin must be a credential-free HTTPS origin");
    }
    for (const [name, value] of Object.entries({
      quoteUrl: control.quoteUrl,
      dispatchUrl: control.dispatchUrl,
      dispatchStatusUrl: control.dispatchStatusUrl,
      lifecycleUrl: control.lifecycleUrl,
      assetQueryUrl: control.assetQueryUrl,
      assetActionUrl: control.assetActionUrl,
    })) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" || url.username || url.password || url.hash ||
        url.origin !== origin.origin || url.search
      ) {
        throw new Error(`${name} must be a credential-free query-free URL on the pinned provider origin`);
      }
    }
    if (
      !/^[1-9]\d*$/.test(control.providerAgentId) || !control.providerAudience ||
      controlProfileIds.has(control.providerAgentId) ||
      control.assetResponseKeyId !== "provider-wallet" ||
      !/^0x[0-9a-fA-F]{40}$/.test(control.assetResponseKey) ||
      !Number.isSafeInteger(control.servicingProfileEpoch) || control.servicingProfileEpoch < 1 ||
      control.tlsPolicy !== "webpki-v1" || control.workloadAuthentication !== "signed-envelopes-v1" ||
      !Number.isSafeInteger(control.maxResponseBytes) || control.maxResponseBytes <= 0 ||
      control.maxResponseBytes > 1_000_000 || !Number.isSafeInteger(control.timeoutMs) ||
      control.timeoutMs < 1_000 || control.timeoutMs > 120_000
    ) throw new Error("Provider control profile policy is invalid");
    controlProfileIds.add(control.providerAgentId);
  }
  for (const admission of manifest.servicingAdmissions) {
    verifyClosedEnvelope(admission, "provider servicing admission envelope");
    await verifyEnvelope(admission, "ProviderServicingAdmissionV1", trust);
    requireClosedKeys(admission.payload as unknown as Record<string, unknown>, [
      "providerAgentId", "providerControlProfileHash", "servicingProfileEpoch",
      "actionCatalogHash", "actionCatalogSchemaHash", "actionCatalogEpoch",
      "servicingEnabled", "previousAdmissionHash", "validFrom", "validBefore",
    ], "provider servicing admission payload");
  }
  for (const catalog of manifest.actionCatalogs) {
    verifyClosedEnvelope(catalog, "provider action catalog envelope");
    await verifyEnvelope(catalog, "ProviderAssetActionCatalogV1", trust);
    requireClosedKeys(catalog.payload as unknown as Record<string, unknown>, [
      "providerAgentId", "providerControlProfileHash", "servicingProfileEpoch",
      "actionCatalogSchemaHash", "actionCatalogEpoch", "actions",
    ], "provider action catalog payload");
    if (
      !/^[1-9]\d*$/.test(catalog.payload.providerAgentId) ||
      !/^0x[0-9a-fA-F]{64}$/.test(catalog.payload.providerControlProfileHash) ||
      !/^0x[0-9a-fA-F]{64}$/.test(catalog.payload.actionCatalogSchemaHash) ||
      !Number.isSafeInteger(catalog.payload.servicingProfileEpoch) ||
      catalog.payload.servicingProfileEpoch < 1 ||
      !Number.isSafeInteger(catalog.payload.actionCatalogEpoch) || catalog.payload.actionCatalogEpoch < 1 ||
      !Array.isArray(catalog.payload.actions)
    ) throw new Error("Provider action catalog is invalid");
    const actionKeys = new Set<string>();
    for (const action of catalog.payload.actions) {
      requireClosedKeys(action as unknown as Record<string, unknown>, [
        "providerAgentId", "serviceId", "serviceSlug", "actionId", "assetType",
        "ownershipPolicy", "destructive", "requestSchema", "responseSchema",
        "confirmationSummarySchema", "confirmationSummaryTemplate", "endpoint",
        "replayPolicy", "retentionSeconds", "validFrom", "validBefore", "actionDefinitionHash",
      ], "provider action definition");
      const { actionDefinitionHash, ...preimage } = action;
      const actionKey = `${action.serviceId.toLowerCase()}:${action.actionId}`;
      let endpoint: URL;
      try { endpoint = new URL(action.endpoint); } catch { throw new Error("Action endpoint is invalid"); }
      if (
        actionKeys.has(actionKey) || action.providerAgentId !== catalog.payload.providerAgentId ||
        typeof action.destructive !== "boolean" ||
        action.ownershipPolicy !== "owner-only" || actionDefinitionHash !== canonicalHash(preimage) ||
        !/^0x[0-9a-fA-F]{64}$/.test(action.serviceId) ||
        !/^[a-z0-9][a-z0-9-]{0,95}$/.test(action.actionId) || !action.serviceSlug || !action.assetType ||
        endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !["stable-result", "regenerate-ephemeral", "redacted-after-window"].includes(action.replayPolicy) ||
        !Number.isSafeInteger(action.retentionSeconds) || action.retentionSeconds < 1 ||
        (action.replayPolicy === "redacted-after-window" && action.retentionSeconds > 604_800) ||
        (action.destructive && action.retentionSeconds <= 600) ||
        !Number.isSafeInteger(action.validFrom) || !Number.isSafeInteger(action.validBefore) ||
        action.validFrom < catalog.issuedAt || action.validBefore > catalog.validBefore ||
        action.validFrom >= action.validBefore ||
        (action.destructive !==
          (action.confirmationSummarySchema !== null && action.confirmationSummaryTemplate !== null))
      ) throw new Error("Provider action definition is invalid");
      compileClosedRequestSchema(action.requestSchema);
      compileClosedResponseSchema(action.responseSchema);
      if (action.destructive) {
        const validateSummary = compileClosedResponseSchema(action.confirmationSummarySchema!);
        assertSchema(validateSummary, action.confirmationSummaryTemplate, "Response");
        if (!summaryBindsRequest(action)) {
          throw new Error("Destructive confirmation summary must bind a request field");
        }
      }
      actionKeys.add(actionKey);
    }
  }
  const admittedActions = new Set<string>();
  for (const admission of manifest.servicingAdmissions) {
    const catalog = manifest.actionCatalogs.find((item) =>
      item.payload.providerAgentId === admission.payload.providerAgentId &&
      canonicalHash(item) === admission.payload.actionCatalogHash
    );
    const controlProfile = manifest.providerControlProfiles.find((item) =>
      item.payload.providerAgentId === admission.payload.providerAgentId &&
      canonicalHash(item) === admission.payload.providerControlProfileHash
    );
    if (
      !catalog || !controlProfile ||
      admission.payload.servicingProfileEpoch !== catalog.payload.servicingProfileEpoch ||
      admission.payload.actionCatalogSchemaHash !== catalog.payload.actionCatalogSchemaHash ||
      admission.payload.actionCatalogEpoch !== catalog.payload.actionCatalogEpoch ||
      controlProfile.payload.servicingProfileEpoch !==
        admission.payload.servicingProfileEpoch
    ) throw new Error("Servicing admission does not bind an active control profile and action catalog");
    for (const action of catalog.payload.actions) {
      // Service admission itself lives in the registration database now; the
      // sealed check pins only the transport binding and uniqueness.
      if (action.endpoint !== controlProfile.payload.assetActionUrl) {
        throw new Error("Action definition is outside its admitted provider service");
      }
      const actionKey = `${action.providerAgentId}:${action.serviceId.toLowerCase()}:${action.actionId}`;
      if (admittedActions.has(actionKey)) throw new Error("Provider service action is admitted more than once");
      admittedActions.add(actionKey);
    }
  }
  requireClosedKeys(manifest.facilitatorProfile.payload as unknown as Record<string, unknown>, [
    "profileEpoch", "profileId", "baseUrl", "scheme", "network", "asset",
    "assetTransferMethod", "authenticationMethod", "credentialPolicyHash", "tlsPolicyHash",
    "allowedExtensionSetHash", "settlementCalldataPolicyHash", "verifyTimeout", "settleTimeout",
    "responseSchemaHash", "screeningPolicyHash", "evidenceAdapterHash", "activatedAt",
    "admissionValidBefore", "recoveryValidBefore",
  ], "facilitator profile payload");
  requireClosedKeys(
    manifest.railCapabilityRequirements.payload as unknown as Record<string, unknown>,
    [
      "requirementId", "scheme", "network", "asset", "assetTransferMethod",
      "authenticatedResponseEvidence", "screeningCoverage", "calldataSemantics",
      "allowedExtensionSetHash",
    ],
    "rail capability requirements payload",
  );
  requireClosedKeys(manifest.activeRailProfile.payload as unknown as Record<string, unknown>, [
    "railEpoch", "facilitatorProfileHash", "priorRailEpoch", "priorActiveRailProfileHash",
    "environment", "chainId", "activatedAt", "admissionValidBefore", "recoveryValidBefore",
  ], "active rail profile payload");
  requireClosedKeys(manifest.chainEvidencePolicy.payload as unknown as Record<string, unknown>, [
    "policyId", "canonicalToken", "canonicalTokenRuntimeCodeHash", "tokenImplementationAddress",
    "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot", "tokenDomainSeparator",
    "maximumSourceLagBlocks", "finalityBlockTimeSeconds", "maximumLogPageEvents",
  ], "chain evidence policy payload");
  const rail = manifest.activeRailProfile.payload;
  const facilitator = manifest.facilitatorProfile.payload;
  const requirements = manifest.railCapabilityRequirements.payload;
  const zeroHash = `0x${"00".repeat(32)}`;
  const isHash = (value: unknown): value is string =>
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
  let facilitatorOrigin: URL;
  try {
    facilitatorOrigin = new URL(facilitator.baseUrl);
  } catch {
    throw new Error("Facilitator profile base URL is invalid");
  }
  if (
    !/^[1-9]\d*$/.test(facilitator.profileEpoch) || !facilitator.profileId ||
    facilitatorOrigin.protocol !== "https:" || facilitatorOrigin.username || facilitatorOrigin.password ||
    facilitatorOrigin.search || facilitatorOrigin.hash || facilitator.scheme !== "exact" ||
    facilitator.assetTransferMethod !== "eip3009" || facilitator.authenticationMethod !== "cdp-jwt-v1" ||
    !/^eip155:\d+$/.test(facilitator.network) ||
    !/^0x[0-9a-fA-F]{40}$/.test(facilitator.asset) ||
    ![
      facilitator.credentialPolicyHash,
      facilitator.tlsPolicyHash,
      facilitator.allowedExtensionSetHash,
      facilitator.settlementCalldataPolicyHash,
      facilitator.responseSchemaHash,
      facilitator.screeningPolicyHash,
      facilitator.evidenceAdapterHash,
    ].every(isHash) ||
    !Number.isSafeInteger(facilitator.verifyTimeout) || facilitator.verifyTimeout < 1_000 ||
    !Number.isSafeInteger(facilitator.settleTimeout) || facilitator.settleTimeout < 1_000 ||
    facilitator.activatedAt < manifest.facilitatorProfile.issuedAt ||
    facilitator.admissionValidBefore <= facilitator.activatedAt ||
    facilitator.recoveryValidBefore <= facilitator.admissionValidBefore ||
    facilitator.recoveryValidBefore > manifest.facilitatorProfile.validBefore
  ) throw new Error("Facilitator profile is invalid");
  if (
    !requirements.requirementId || requirements.scheme !== facilitator.scheme ||
    requirements.network !== facilitator.network ||
    getAddress(requirements.asset) !== getAddress(facilitator.asset) ||
    requirements.assetTransferMethod !== facilitator.assetTransferMethod ||
    requirements.authenticatedResponseEvidence !== facilitator.authenticationMethod ||
    requirements.screeningCoverage !== "gateway-and-facilitator-v1" ||
    requirements.calldataSemantics !== "transferWithAuthorization-v1" ||
    requirements.allowedExtensionSetHash.toLowerCase() !== facilitator.allowedExtensionSetHash.toLowerCase()
  ) throw new Error("Facilitator profile does not satisfy the rail capability requirements");
  if (
    !/^[1-9]\d*$/.test(rail.railEpoch) ||
    rail.environment !== trust.environment || rail.chainId !== trust.chainId ||
    rail.activatedAt < manifest.activeRailProfile.issuedAt ||
    rail.admissionValidBefore <= rail.activatedAt || rail.recoveryValidBefore <= rail.admissionValidBefore ||
    rail.recoveryValidBefore > manifest.activeRailProfile.validBefore ||
    ((rail.priorRailEpoch === "0") !== (rail.priorActiveRailProfileHash.toLowerCase() === zeroHash))
  ) throw new Error("Active rail profile chronology or predecessor is invalid");
  if (rail.facilitatorProfileHash.toLowerCase() !== canonicalHash(manifest.facilitatorProfile).toLowerCase()) {
    throw new Error("Active rail profile does not bind the facilitator profile");
  }
  const chainPolicy = manifest.chainEvidencePolicy.payload;
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(chainPolicy.canonicalToken) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.canonicalTokenRuntimeCodeHash) ||
    !/^0x[0-9a-fA-F]{40}$/.test(chainPolicy.tokenImplementationAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenImplementationRuntimeCodeHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenImplementationSlot) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenDomainSeparator) ||
    !Number.isSafeInteger(chainPolicy.maximumSourceLagBlocks) || chainPolicy.maximumSourceLagBlocks < 0 ||
    !Number.isSafeInteger(chainPolicy.finalityBlockTimeSeconds) || chainPolicy.finalityBlockTimeSeconds < 1 ||
    !Number.isSafeInteger(chainPolicy.maximumLogPageEvents) || chainPolicy.maximumLogPageEvents < 1 ||
    chainPolicy.maximumLogPageEvents > 100_000
  ) throw new Error("Chain evidence policy is invalid");
}

function summaryBindsRequest(action: AssetActionDefinitionV1): boolean {
  const requestProperties = action.requestSchema.properties as Record<string, Record<string, unknown>>;
  const summaryProperties = action.confirmationSummarySchema!.properties as Record<string, Record<string, unknown>>;
  const bindable = new Set(["actionId", "providerAssetId", ...Object.keys(requestProperties)]);
  return Object.keys(action.confirmationSummaryTemplate!).some((key) => {
    if (!bindable.has(key)) return false;
    const requestType = key === "actionId" || key === "providerAssetId"
      ? "string"
      : requestProperties[key]?.type;
    return requestType === summaryProperties[key]?.type;
  });
}

