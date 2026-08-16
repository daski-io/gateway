import { getAddress, recoverMessageAddress, type Address } from "viem";
import { artifactPayloadHash, canonicalHash, providerIdentitySnapshotHash } from "./canonical.js";
import type {
  AssetActionDefinitionV1,
  SignedEnvelope,
  StandardListing,
  StandardRailManifest,
} from "./types.js";
import {
  assertSchema,
  compileClosedRequestSchema,
  compileClosedResponseSchema,
} from "./schema.js";
import { assertListingRoleSeparation } from "./listingRoles.js";

const LAUNCH_ACTION_CLASSIFICATION = new Map<string, boolean>([
  ["get-domain-info", false],
  ["list-dns-records", false],
  ["set-dns-record", false],
  ["delete-dns-record", false],
  ["get-mailbox-info", false],
  ["change-password", false],
  ["delete-mailbox", true],
  ["get-entity-status", false],
  ["list-entity-documents", false],
  ["download-entity-document", false],
]);

const LAUNCH_REPLAY_POLICIES = new Map<string, AssetActionDefinitionV1["replayPolicy"]>([
  ["get-domain-info", "stable-result"],
  ["list-dns-records", "stable-result"],
  ["set-dns-record", "stable-result"],
  ["delete-dns-record", "stable-result"],
  ["get-mailbox-info", "stable-result"],
  ["change-password", "redacted-after-window"],
  ["delete-mailbox", "stable-result"],
  ["get-entity-status", "stable-result"],
  ["list-entity-documents", "stable-result"],
  ["download-entity-document", "regenerate-ephemeral"],
]);

export interface ArtifactTrust {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  signers: ReadonlyMap<string, Address>;
  launchOutcomeIds: readonly string[];
}

export async function verifyEnvelope<T>(
  envelope: SignedEnvelope<T>,
  expectedType: string,
  trust: ArtifactTrust,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  if (envelope.artifactType !== expectedType || envelope.schemaVersion !== 1) {
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

function verifyClosedEnvelope(envelope: SignedEnvelope<unknown>, label: string): void {
  requireClosedKeys(envelope as unknown as Record<string, unknown>, ENVELOPE_KEYS, label);
}

export async function verifyStandardRailManifest(
  manifest: StandardRailManifest,
  trust: ArtifactTrust,
): Promise<void> {
  requireClosedKeys(manifest as unknown as Record<string, unknown>, [
    "facilitatorProfile", "railCapabilityRequirements", "activeRailProfile",
    "chainEvidencePolicy", "providerIdentitySnapshots",
    "servicingAdmissions",
    "actionCatalogs", "listings",
  ], "standard rail manifest");
  verifyClosedEnvelope(manifest.facilitatorProfile, "facilitator profile envelope");
  verifyClosedEnvelope(manifest.railCapabilityRequirements, "rail capability requirements envelope");
  verifyClosedEnvelope(manifest.activeRailProfile, "active rail profile envelope");
  verifyClosedEnvelope(manifest.chainEvidencePolicy, "chain evidence policy envelope");
  await verifyEnvelope(manifest.facilitatorProfile, "FacilitatorProfileV1", trust);
  await verifyEnvelope(manifest.railCapabilityRequirements, "RailCapabilityRequirementsV1", trust);
  await verifyEnvelope(manifest.activeRailProfile, "ActiveRailProfileV1", trust);
  await verifyEnvelope(manifest.chainEvidencePolicy, "ChainEvidencePolicyV1", trust);
  for (const snapshot of manifest.providerIdentitySnapshots) {
    verifyClosedEnvelope(snapshot, "provider identity snapshot envelope");
    await verifyEnvelope(snapshot, "ProviderIdentitySnapshotV1", trust);
    requireClosedKeys(snapshot.payload as unknown as Record<string, unknown>, [
      "providerAgentId", "serviceId", "identityRegistry", "providerRegistry", "serviceRegistry",
      "providerOwner", "providerAgentWallet", "providerPayee", "blockNumber", "blockHash",
    ], "provider identity snapshot payload");
    if (
      !/^[1-9]\d*$/.test(snapshot.payload.providerAgentId) ||
      !/^[1-9]\d*$/.test(snapshot.payload.blockNumber) ||
      !/^0x[0-9a-fA-F]{64}$/.test(snapshot.payload.serviceId) ||
      !/^0x[0-9a-fA-F]{64}$/.test(snapshot.payload.blockHash) ||
      [snapshot.payload.identityRegistry, snapshot.payload.providerRegistry,
        snapshot.payload.serviceRegistry, snapshot.payload.providerOwner,
        snapshot.payload.providerAgentWallet, snapshot.payload.providerPayee]
        .some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value))
    ) throw new Error("Provider identity snapshot is invalid");
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
    const actionIds = new Set<string>();
    for (const action of catalog.payload.actions) {
      requireClosedKeys(action as unknown as Record<string, unknown>, [
        "providerAgentId", "serviceId", "serviceSlug", "actionId", "assetType",
        "ownershipPolicy", "destructive", "requestSchema", "responseSchema",
        "confirmationSummarySchema", "confirmationSummaryTemplate", "endpoint",
        "replayPolicy", "retentionSeconds", "validFrom", "validBefore", "actionDefinitionHash",
      ], "provider action definition");
      const { actionDefinitionHash, ...preimage } = action;
      const destructive = LAUNCH_ACTION_CLASSIFICATION.get(action.actionId);
      const replayPolicy = LAUNCH_REPLAY_POLICIES.get(action.actionId);
      let endpoint: URL;
      try { endpoint = new URL(action.endpoint); } catch { throw new Error("Action endpoint is invalid"); }
      if (
        actionIds.has(action.actionId) || action.providerAgentId !== catalog.payload.providerAgentId ||
        destructive === undefined || action.destructive !== destructive ||
        replayPolicy === undefined || action.replayPolicy !== replayPolicy ||
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
      actionIds.add(action.actionId);
    }
  }
  const admittedActions = new Set<string>();
  for (const admission of manifest.servicingAdmissions) {
    const catalog = manifest.actionCatalogs.find((item) =>
      item.payload.providerAgentId === admission.payload.providerAgentId &&
      canonicalHash(item) === admission.payload.actionCatalogHash
    );
    const listing = manifest.listings.find((item) =>
      item.commitment.payload.providerAgentId === admission.payload.providerAgentId &&
      canonicalHash(item.providerControlProfile) === admission.payload.providerControlProfileHash
    );
    if (
      !catalog || !listing ||
      admission.payload.servicingProfileEpoch !== catalog.payload.servicingProfileEpoch ||
      admission.payload.actionCatalogSchemaHash !== catalog.payload.actionCatalogSchemaHash ||
      admission.payload.actionCatalogEpoch !== catalog.payload.actionCatalogEpoch ||
      listing.providerControlProfile.payload.servicingProfileEpoch !==
        admission.payload.servicingProfileEpoch
    ) throw new Error("Servicing admission does not bind an active control profile and action catalog");
    for (const action of catalog.payload.actions) {
      if (
        action.endpoint !== listing.providerControlProfile.payload.assetActionUrl ||
        !manifest.listings.some((item) =>
          item.commitment.payload.providerAgentId === action.providerAgentId &&
          item.commitment.payload.serviceId === action.serviceId)
      ) throw new Error("Action definition is outside its admitted provider service");
      if (admittedActions.has(action.actionId)) throw new Error("Launch action is admitted more than once");
      admittedActions.add(action.actionId);
    }
  }
  if (
    admittedActions.size !== LAUNCH_ACTION_CLASSIFICATION.size ||
    [...LAUNCH_ACTION_CLASSIFICATION.keys()].some((actionId) => !admittedActions.has(actionId))
  ) throw new Error("Servicing admissions do not contain the exact reviewed launch action set");
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
    "maximumSourceLagBlocks", "finalityBlockTimeSeconds", "maximumIntervalEvents",
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
    manifest.listings.length === 0 || !/^[1-9]\d*$/.test(rail.railEpoch) ||
    rail.environment !== trust.environment || rail.chainId !== trust.chainId ||
    rail.activatedAt < manifest.activeRailProfile.issuedAt ||
    rail.admissionValidBefore <= rail.activatedAt || rail.recoveryValidBefore <= rail.admissionValidBefore ||
    rail.recoveryValidBefore > manifest.activeRailProfile.validBefore ||
    ((rail.priorRailEpoch === "0") !== (rail.priorActiveRailProfileHash.toLowerCase() === zeroHash))
  ) throw new Error("Active rail profile chronology or predecessor is invalid");
  const actual = manifest.listings.map((item) => item.commitment.payload.outcomeId).sort();
  const expected = [...trust.launchOutcomeIds].sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error("Active listings do not match the reviewed launch outcome allowlist");
  }
  if (rail.facilitatorProfileHash.toLowerCase() !== canonicalHash(manifest.facilitatorProfile).toLowerCase()) {
    throw new Error("Active rail profile does not bind the facilitator profile");
  }
  const chainPolicy = manifest.chainEvidencePolicy.payload;
  const chainPolicyHash = canonicalHash(manifest.chainEvidencePolicy);
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(chainPolicy.canonicalToken) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.canonicalTokenRuntimeCodeHash) ||
    !/^0x[0-9a-fA-F]{40}$/.test(chainPolicy.tokenImplementationAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenImplementationRuntimeCodeHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenImplementationSlot) ||
    !/^0x[0-9a-fA-F]{64}$/.test(chainPolicy.tokenDomainSeparator) ||
    !Number.isSafeInteger(chainPolicy.maximumSourceLagBlocks) || chainPolicy.maximumSourceLagBlocks < 0 ||
    !Number.isSafeInteger(chainPolicy.finalityBlockTimeSeconds) || chainPolicy.finalityBlockTimeSeconds < 1 ||
    !Number.isSafeInteger(chainPolicy.maximumIntervalEvents) || chainPolicy.maximumIntervalEvents < 1 ||
    chainPolicy.maximumIntervalEvents > 100_000
  ) throw new Error("Chain evidence policy is invalid");
  const seen = new Set<string>();
  for (const listing of manifest.listings) {
    await verifyListing(listing, trust);
    const snapshot = manifest.providerIdentitySnapshots.find((item) =>
      providerIdentitySnapshotHash(item.payload, trust.chainId) ===
        listing.commitment.payload.providerIdentitySnapshotHash
    );
    if (
      !snapshot || snapshot.payload.providerAgentId !== listing.commitment.payload.providerAgentId ||
      snapshot.payload.serviceId !== listing.commitment.payload.serviceId ||
      getAddress(snapshot.payload.providerAgentWallet) !==
        getAddress(listing.commitment.payload.providerAuthorityKey) ||
      getAddress(snapshot.payload.providerPayee) !== getAddress(listing.commitment.payload.providerPayee)
    ) throw new Error("Listing provider identity snapshot is missing or inconsistent");
    const key = `${listing.commitment.payload.providerAgentId}:${listing.commitment.payload.outcomeId}`;
    if (seen.has(key)) throw new Error(`Duplicate active listing ${key}`);
    seen.add(key);
    if (
      listing.commitment.payload.chainEvidencePolicyHash.toLowerCase() !== chainPolicyHash.toLowerCase() ||
      listing.commitment.payload.railCapabilityRequirementsHash.toLowerCase() !==
        canonicalHash(manifest.railCapabilityRequirements).toLowerCase() ||
      getAddress(listing.commitment.payload.canonicalToken) !== getAddress(chainPolicy.canonicalToken)
    ) throw new Error("Listing does not bind the active chain evidence policy");
  }
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

async function verifyListing(listing: StandardListing, trust: ArtifactTrust): Promise<void> {
  requireClosedKeys(listing as unknown as Record<string, unknown>, [
    "commitment", "manifest", "offer", "providerControlProfile", "title", "description", "discovery",
    "requestSchema", "responseSchema", "terms", "screeningPolicy", "buyerIdentityPolicy",
    "extensionPolicy", "quotePolicy", "deliveryCommitment", "capacityPolicy", "deadlinePolicy",
  ], "standard listing");
  verifyClosedEnvelope(listing.commitment, "listing commitment envelope");
  verifyClosedEnvelope(listing.manifest, "listing manifest envelope");
  verifyClosedEnvelope(listing.offer, "provider offer envelope");
  verifyClosedEnvelope(listing.providerControlProfile, "provider control profile envelope");
  await verifyEnvelope(listing.commitment, "ListingCommitmentV1", trust);
  await verifyEnvelope(listing.manifest, "ListingEpochManifestV1", trust);
  await verifyEnvelope(listing.providerControlProfile, "ProviderControlProfileV1", trust);
  await verifyEnvelope(listing.offer, "ProviderOutcomeOfferV1", {
    ...trust,
    signers: new Map([[listing.offer.signerKeyId, listing.commitment.payload.providerAuthorityKey]]),
  });
  const commitmentHash = canonicalHash(listing.commitment);
  const manifestHash = canonicalHash(listing.manifest);
  const controlProfileHash = canonicalHash(listing.providerControlProfile);
  requireClosedKeys(listing.commitment.payload as unknown as Record<string, unknown>, [
    "canonicalToken", "railCapabilityRequirementsHash", "providerAgentId", "serviceId",
    "providerIdentitySnapshotHash", "providerAuthorityKey",
    "providerTerminalAttestationKey", "providerPayee", "providerControlProfileHash", "outcomeId",
    "method", "absoluteResourceUri", "bindingProfile", "requestSchemaHash", "responseSchemaHash",
    "canonicalizationProfile", "buyerIdentityPolicyHash", "daskiCommissionReceiver", "commissionBps",
    "termsHash", "screeningPolicyHash", "chainEvidencePolicyHash",
    "extensionPolicyHash", "listingEpoch", "validFrom", "validUntil", "splitterFactory",
    "splitterCreationCodeHash", "splitterDeploymentSalt",
  ], "listing commitment payload");
  requireClosedKeys(listing.manifest.payload as unknown as Record<string, unknown>, [
    "listingCommitmentHash", "splitterAddress", "splitterRuntimeCodeHash", "splitterImmutableHash",
    "splitterDeploymentTransaction", "splitterDeploymentBlockNumber", "splitterDeploymentBlockHash",
  ], "listing manifest payload");
  requireClosedKeys(listing.offer.payload as unknown as Record<string, unknown>, [
    "listingManifestHash", "outcomeId", "providerAgentId", "providerPayee", "pricingMode",
    "fixedGrossAmount", "quotePolicyHash", "capacityPolicyHash", "deadlinePolicyHash",
    "deliveryCommitment", "termsHash", "issuedAt", "validBefore", "offerNonce",
  ], "provider offer payload");
  requireClosedKeys(listing.terms as unknown as Record<string, unknown>, [
    "marketplaceTermsUrl", "marketplacePrivacyUrl", "providerLegalName", "providerTermsUrl",
    "providerPrivacyUrl",
  ], "listing terms");
  requireClosedKeys(listing.discovery as unknown as Record<string, unknown>, [
    "categoryFamily", "serviceType", "jurisdictions", "tags", "persistentAsset",
    "fulfillmentObligationHash", "jurisdictionObligationHashes",
  ], "listing discovery metadata");
  if (
    !listing.discovery.categoryFamily || !listing.discovery.serviceType ||
    listing.discovery.jurisdictions.length < 1 ||
    new Set(listing.discovery.jurisdictions).size !== listing.discovery.jurisdictions.length ||
    new Set(listing.discovery.tags).size !== listing.discovery.tags.length ||
    !/^0x[0-9a-fA-F]{64}$/.test(listing.discovery.fulfillmentObligationHash) ||
    Object.keys(listing.discovery.jurisdictionObligationHashes).sort().join(",") !==
      [...listing.discovery.jurisdictions].sort().join(",") ||
    Object.values(listing.discovery.jurisdictionObligationHashes)
      .some((value) => !/^0x[0-9a-fA-F]{64}$/.test(value))
  ) throw new Error("Listing discovery metadata is invalid");
  requireClosedKeys(listing.screeningPolicy as unknown as Record<string, unknown>, [
    "policyId", "sanctionsOracle", "sanctionsOracleRuntimeCodeHash", "screenPayer", "screenedRoles",
    "providerControlledWallets",
  ], "screening policy");
  requireClosedKeys(listing.buyerIdentityPolicy as unknown as Record<string, unknown>, [
    "policyId",
  ], "buyer identity policy");
  requireClosedKeys(listing.extensionPolicy as unknown as Record<string, unknown>, [
    "requiredExtensions", "optionalExtensions",
  ], "extension policy");
  if (listing.quotePolicy) {
    requireClosedKeys(listing.quotePolicy as unknown as Record<string, unknown>, [
      "maximumLifetimeSeconds", "minimumPaymentWindowSeconds", "personalizedPricing",
    ], "quote policy");
  }
  requireClosedKeys(listing.deliveryCommitment as unknown as Record<string, unknown>, [
    "deliveryMode", "customerKyc", "terminalAttestation", "responseValidation",
  ], "delivery commitment");
  requireClosedKeys(listing.capacityPolicy as unknown as Record<string, unknown>, [
    "maxOpenOrders",
  ], "capacity policy");
  requireClosedKeys(listing.deadlinePolicy as unknown as Record<string, unknown>, [
    "draftSeconds", "minimumPaymentWindowSeconds", "verificationSeconds",
    "settlementEvidenceSeconds", "releaseEvidenceSeconds", "dispatchSeconds", "fulfillmentSeconds",
  ], "deadline policy");
  if (listing.manifest.payload.listingCommitmentHash !== commitmentHash) {
    throw new Error("Listing manifest commitment hash mismatch");
  }
  if (!/^\d+$/.test(listing.manifest.payload.splitterDeploymentBlockNumber)) {
    throw new Error("Listing deployment block number is invalid");
  }
  if (listing.offer.payload.listingManifestHash !== manifestHash) {
    throw new Error("Provider offer listing hash mismatch");
  }
  if (listing.commitment.payload.providerControlProfileHash !== controlProfileHash) {
    throw new Error("Listing commitment provider control profile hash mismatch");
  }
  const commitment = listing.commitment.payload;
  const offer = listing.offer.payload;
  const control = listing.providerControlProfile.payload;
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
    absoluteResourceUri: commitment.absoluteResourceUri,
  })) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(`${name} must be a credential-free HTTPS URL without a fragment`);
    }
    if (name !== "absoluteResourceUri" && (url.origin !== origin.origin || url.search)) {
      throw new Error(`${name} must be a query-free URL on the pinned provider origin`);
    }
  }
  if (
    control.providerAgentId !== commitment.providerAgentId || !control.providerAudience ||
    !/^0x[0-9a-fA-F]{64}$/.test(commitment.serviceId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(commitment.providerIdentitySnapshotHash) ||
    control.assetResponseKeyId !== "provider-wallet" ||
    !/^0x[0-9a-fA-F]{40}$/.test(control.assetResponseKey) ||
    getAddress(control.assetResponseKey) !== getAddress(commitment.providerAuthorityKey) ||
    !Number.isSafeInteger(control.servicingProfileEpoch) || control.servicingProfileEpoch < 1 ||
    control.tlsPolicy !== "webpki-v1" || control.workloadAuthentication !== "signed-envelopes-v1" ||
    !Number.isSafeInteger(control.maxResponseBytes) || control.maxResponseBytes <= 0 ||
    control.maxResponseBytes > 1_000_000 || !Number.isSafeInteger(control.timeoutMs) ||
    control.timeoutMs < 1_000 || control.timeoutMs > 120_000
  ) throw new Error("Provider control profile policy is invalid");
  if (
    canonicalHash(listing.requestSchema) !== commitment.requestSchemaHash ||
    canonicalHash(listing.responseSchema) !== commitment.responseSchemaHash
  ) throw new Error("Listing schema content hash mismatch");
  if (
    !/^\d+$/.test(commitment.listingEpoch) || commitment.validFrom >= commitment.validUntil ||
    offer.issuedAt < commitment.validFrom || offer.validBefore > commitment.validUntil ||
    !Number.isSafeInteger(commitment.commissionBps) || commitment.commissionBps <= 0 ||
    commitment.commissionBps >= 10_000 ||
    (offer.pricingMode === "fixed" && !/^[1-9][0-9]*$/.test(offer.fixedGrossAmount)) ||
    (offer.pricingMode === "dynamic" && offer.fixedGrossAmount !== "0") ||
    (offer.pricingMode === "fixed" && offer.quotePolicyHash.toLowerCase() !== `0x${"00".repeat(32)}`) ||
    (offer.pricingMode === "dynamic" && !listing.quotePolicy) ||
    (offer.pricingMode === "fixed" && listing.quotePolicy !== null)
  ) throw new Error("Listing validity or pricing policy is invalid");
  if (listing.quotePolicy && (
    canonicalHash(listing.quotePolicy) !== offer.quotePolicyHash ||
    !Number.isSafeInteger(listing.quotePolicy.maximumLifetimeSeconds) ||
    listing.quotePolicy.maximumLifetimeSeconds < 30 ||
    !Number.isSafeInteger(listing.quotePolicy.minimumPaymentWindowSeconds) ||
    listing.quotePolicy.minimumPaymentWindowSeconds < 15 ||
    listing.quotePolicy.minimumPaymentWindowSeconds >= listing.quotePolicy.maximumLifetimeSeconds ||
    listing.quotePolicy.personalizedPricing !== false
  )) throw new Error("Quote policy is invalid");
  if (offer.pricingMode === "fixed") {
    const bps = BigInt(commitment.commissionBps);
    const minimumReleasableAmount = (10_000n + bps - 1n) / bps;
    if (BigInt(offer.fixedGrossAmount) < minimumReleasableAmount) {
      throw new Error("Fixed price cannot produce both splitter payment legs");
    }
  }
  const providerControlKey = getAddress(commitment.providerAuthorityKey).toLowerCase();
  if (providerControlKey !== getAddress(commitment.providerTerminalAttestationKey).toLowerCase()) {
    throw new Error("Provider authority and terminal attestations must use the provider wallet");
  }
  const roleAddresses = [
    providerControlKey,
    commitment.providerPayee,
    commitment.daskiCommissionReceiver,
  ].map((value) => getAddress(value).toLowerCase());
  assertListingRoleSeparation(
    commitment.providerAuthorityKey,
    commitment.providerPayee,
    commitment.daskiCommissionReceiver,
  );
  if (
    canonicalHash(listing.screeningPolicy) !== commitment.screeningPolicyHash ||
    !listing.screeningPolicy.policyId || listing.screeningPolicy.screenPayer !== true ||
    !/^0x[0-9a-fA-F]{40}$/.test(listing.screeningPolicy.sanctionsOracle) ||
    !/^0x[0-9a-fA-F]{64}$/.test(listing.screeningPolicy.sanctionsOracleRuntimeCodeHash) ||
    listing.screeningPolicy.screenedRoles.length === 0 ||
    new Set(listing.screeningPolicy.screenedRoles).size !== listing.screeningPolicy.screenedRoles.length ||
    listing.screeningPolicy.providerControlledWallets.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value)) ||
    new Set(listing.screeningPolicy.providerControlledWallets.map((value) => getAddress(value).toLowerCase())).size !==
      listing.screeningPolicy.providerControlledWallets.length
  ) throw new Error("Screening policy content hash mismatch or policy is invalid");
  const controlledWallets = listing.screeningPolicy.providerControlledWallets
    .map((value) => getAddress(value).toLowerCase());
  if (controlledWallets.some((value) => roleAddresses.includes(value))) {
    throw new Error("Provider-controlled wallets must not duplicate listing role wallets");
  }
  if (
    canonicalHash(listing.buyerIdentityPolicy) !== commitment.buyerIdentityPolicyHash ||
    listing.buyerIdentityPolicy.policyId !== "none"
  ) throw new Error("Buyer identity policy content hash mismatch or policy is unsupported");
  const requiredExtensions = [
    "bazaar", "daski-rail-profile", "daski-order-terms",
    ...(commitment.bindingProfile === "recipe-bound-v1" ? ["daski-order-binding"] : []),
  ].sort();
  if (
    canonicalHash(listing.extensionPolicy) !== commitment.extensionPolicyHash ||
    canonicalHash([...listing.extensionPolicy.requiredExtensions].sort()) !== canonicalHash(requiredExtensions) ||
    canonicalHash([...listing.extensionPolicy.optionalExtensions].sort()) !== canonicalHash(["payment-identifier"]) ||
    new Set([
      ...listing.extensionPolicy.requiredExtensions,
      ...listing.extensionPolicy.optionalExtensions,
    ]).size !== listing.extensionPolicy.requiredExtensions.length + listing.extensionPolicy.optionalExtensions.length
  ) throw new Error("Extension policy content hash mismatch or policy is invalid");
  if (
    canonicalHash(listing.deliveryCommitment) !== offer.deliveryCommitment ||
    listing.deliveryCommitment.deliveryMode !== "asynchronous-v1" ||
    listing.deliveryCommitment.customerKyc !== "provider-post-payment-v1" ||
    listing.deliveryCommitment.terminalAttestation !== "provider-signed-v1" ||
    listing.deliveryCommitment.responseValidation !== "closed-schema-v1"
  ) throw new Error("Delivery commitment content hash mismatch or policy is invalid");
  if (canonicalHash(listing.terms) !== commitment.termsHash) {
    throw new Error("Terms content hash mismatch");
  }
  for (const [name, value] of Object.entries(listing.terms).filter(([name]) => name.endsWith("Url"))) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new Error(`${name} must be a credential-free HTTPS URL without a fragment`);
    }
  }
  if (
    canonicalHash(listing.capacityPolicy) !== offer.capacityPolicyHash ||
    !Number.isSafeInteger(listing.capacityPolicy.maxOpenOrders) ||
    listing.capacityPolicy.maxOpenOrders <= 0
  ) {
    throw new Error("Capacity policy content hash mismatch");
  }
  const deadlines = listing.deadlinePolicy;
  if (
    canonicalHash(deadlines) !== offer.deadlinePolicyHash ||
    Object.values(deadlines).some((value) => !Number.isSafeInteger(value) || value < 30) ||
    deadlines.minimumPaymentWindowSeconds >= deadlines.draftSeconds ||
    deadlines.dispatchSeconds * 1_000 < control.timeoutMs
  ) throw new Error("Deadline policy content hash mismatch");
  if (
    offer.providerAgentId !== commitment.providerAgentId ||
    getAddress(offer.providerPayee) !== getAddress(commitment.providerPayee) ||
    offer.outcomeId !== commitment.outcomeId ||
    offer.termsHash !== commitment.termsHash
  ) {
    throw new Error("Provider offer conflicts with listing commitment");
  }
  requireClosedKeys(listing.requestSchema, ["$schema", "type", "properties", "required", "additionalProperties", "maxProperties"], "request schema");
  if (
    commitment.bindingProfile === "stock-fixed-v1" &&
    (
      canonicalHash(listing.requestSchema.properties) !== canonicalHash({}) ||
      canonicalHash(listing.requestSchema.required) !== canonicalHash([]) ||
      listing.requestSchema.maxProperties !== 0
    )
  ) throw new Error("Stock-fixed listings cannot accept buyer-selected request fields");
}
