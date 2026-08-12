import { getAddress, recoverMessageAddress, type Address } from "viem";
import { artifactPayloadHash, canonicalHash } from "./canonical.js";
import type {
  SignedEnvelope,
  StandardListing,
  StandardRailManifest,
} from "./types.js";

export interface ArtifactTrust {
  environment: string;
  chainId: number;
  gatewayAudience: string;
  signers: ReadonlyMap<string, Address>;
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
    "facilitatorProfile", "facilitatorCredentialBinding", "railCapabilityRequirements",
    "activeRailProfile", "chainEvidencePolicy", "runtimeRelease", "listings",
  ], "standard rail manifest");
  verifyClosedEnvelope(manifest.facilitatorProfile, "facilitator profile envelope");
  verifyClosedEnvelope(manifest.facilitatorCredentialBinding, "facilitator credential binding envelope");
  verifyClosedEnvelope(manifest.railCapabilityRequirements, "rail capability requirements envelope");
  verifyClosedEnvelope(manifest.activeRailProfile, "active rail profile envelope");
  verifyClosedEnvelope(manifest.chainEvidencePolicy, "chain evidence policy envelope");
  verifyClosedEnvelope(manifest.runtimeRelease, "runtime release envelope");
  await verifyEnvelope(manifest.facilitatorProfile, "FacilitatorProfileV1", trust);
  await verifyEnvelope(
    manifest.facilitatorCredentialBinding,
    "FacilitatorCredentialBindingV1",
    trust,
  );
  await verifyEnvelope(manifest.railCapabilityRequirements, "RailCapabilityRequirementsV1", trust);
  await verifyEnvelope(manifest.activeRailProfile, "ActiveRailProfileV1", trust);
  await verifyEnvelope(manifest.chainEvidencePolicy, "ChainEvidencePolicyV1", trust);
  await verifyEnvelope(manifest.runtimeRelease, "RuntimeReleaseManifestV1", trust);
  requireClosedKeys(manifest.facilitatorProfile.payload as unknown as Record<string, unknown>, [
    "profileEpoch", "profileId", "baseUrl", "scheme", "network", "asset",
    "assetTransferMethod", "authenticationMethod", "credentialPolicyHash", "tlsPolicyHash",
    "allowedExtensionSetHash", "settlementCalldataPolicyHash", "verifyTimeout", "settleTimeout",
    "responseSchemaHash", "screeningPolicyHash", "evidenceAdapterHash", "activatedAt",
    "admissionValidBefore", "recoveryValidBefore",
  ], "facilitator profile payload");
  requireClosedKeys(
    manifest.facilitatorCredentialBinding.payload as unknown as Record<string, unknown>,
    [
      "credentialEpoch", "facilitatorProfileHash", "credentialKeyIdHash", "authenticationMethod",
      "workloadIdentityHash", "priorCredentialBindingHash", "activatedAt", "admissionValidBefore",
      "recoveryValidBefore",
    ],
    "facilitator credential binding payload",
  );
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
  requireClosedKeys(manifest.runtimeRelease.payload as unknown as Record<string, unknown>, [
    "runtimeEpoch", "gatewayReleaseDigest", "containerOrBinaryDigest", "databaseSchemaVersion",
    "canonicalConfigurationHash", "activeRailProfileHash", "facilitatorCredentialBindingHash",
    "chainEvidencePolicyHash", "activeListingManifestSetHash", "providerControlProfileSetHash",
    "adapterArtifactSetHash", "keyPolicySetHash", "environment", "chainId", "issuedAt",
    "admissionValidBefore", "recoveryValidBefore",
  ], "runtime release payload");
  requireClosedKeys(manifest.chainEvidencePolicy.payload as unknown as Record<string, unknown>, [
    "policyId", "canonicalToken", "canonicalTokenRuntimeCodeHash", "tokenImplementationAddress",
    "tokenImplementationRuntimeCodeHash", "tokenImplementationSlot", "tokenDomainSeparator",
    "maximumSourceLagBlocks", "finalityBlockTimeSeconds", "maximumIntervalEvents",
  ], "chain evidence policy payload");
  const rail = manifest.activeRailProfile.payload;
  const runtime = manifest.runtimeRelease.payload;
  const facilitator = manifest.facilitatorProfile.payload;
  const credential = manifest.facilitatorCredentialBinding.payload;
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
    !/^[1-9]\d*$/.test(credential.credentialEpoch) ||
    ![
      credential.facilitatorProfileHash,
      credential.credentialKeyIdHash,
      credential.workloadIdentityHash,
      credential.priorCredentialBindingHash,
    ].every(isHash) ||
    credential.facilitatorProfileHash.toLowerCase() !== canonicalHash(manifest.facilitatorProfile).toLowerCase() ||
    credential.authenticationMethod !== facilitator.authenticationMethod ||
    credential.activatedAt < manifest.facilitatorCredentialBinding.issuedAt ||
    credential.admissionValidBefore <= credential.activatedAt ||
    credential.recoveryValidBefore <= credential.admissionValidBefore ||
    credential.recoveryValidBefore > manifest.facilitatorCredentialBinding.validBefore
  ) throw new Error("Facilitator credential binding is invalid");
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
  if (
    !/^[1-9]\d*$/.test(runtime.runtimeEpoch) || runtime.databaseSchemaVersion !== "031_standard_rail.sql" ||
    runtime.environment !== trust.environment || runtime.chainId !== trust.chainId ||
    runtime.issuedAt !== manifest.runtimeRelease.issuedAt ||
    runtime.admissionValidBefore <= runtime.issuedAt || runtime.recoveryValidBefore <= runtime.admissionValidBefore ||
    runtime.recoveryValidBefore > manifest.runtimeRelease.validBefore
  ) throw new Error("Runtime release chronology or schema version is invalid");
  const railHash = canonicalHash(manifest.activeRailProfile);
  if (rail.facilitatorProfileHash.toLowerCase() !== canonicalHash(manifest.facilitatorProfile).toLowerCase()) {
    throw new Error("Active rail profile does not bind the facilitator profile");
  }
  if (manifest.runtimeRelease.payload.activeRailProfileHash.toLowerCase() !== railHash.toLowerCase()) {
    throw new Error("Runtime release does not bind the active rail profile");
  }
  if (
    manifest.runtimeRelease.payload.facilitatorCredentialBindingHash.toLowerCase() !==
      canonicalHash(manifest.facilitatorCredentialBinding).toLowerCase()
  ) throw new Error("Runtime release does not bind the facilitator credential binding");
  const chainPolicy = manifest.chainEvidencePolicy.payload;
  const chainPolicyHash = canonicalHash(manifest.chainEvidencePolicy);
  if (
    manifest.runtimeRelease.payload.chainEvidencePolicyHash.toLowerCase() !== chainPolicyHash.toLowerCase() ||
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
  const listingSetHash = canonicalHash(manifest.listings
    .map((listing) => canonicalHash(listing.manifest).toLowerCase()).sort());
  const controlProfileSetHash = canonicalHash(manifest.listings
    .map((listing) => canonicalHash(listing.providerControlProfile).toLowerCase()).sort());
  if (manifest.runtimeRelease.payload.activeListingManifestSetHash.toLowerCase() !== listingSetHash) {
    throw new Error("Runtime release active listing set hash mismatch");
  }
  if (manifest.runtimeRelease.payload.providerControlProfileSetHash.toLowerCase() !== controlProfileSetHash) {
    throw new Error("Runtime release provider control profile set hash mismatch");
  }
}

async function verifyListing(listing: StandardListing, trust: ArtifactTrust): Promise<void> {
  requireClosedKeys(listing as unknown as Record<string, unknown>, [
    "commitment", "manifest", "offer", "providerControlProfile", "title", "description",
    "requestSchema", "responseSchema", "terms", "screeningPolicy", "buyerIdentityPolicy",
    "extensionPolicy", "quotePolicy", "deliveryCommitment", "capacityPolicy", "deadlinePolicy",
    "refundPolicy",
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
    "canonicalToken", "railCapabilityRequirementsHash", "providerAgentId", "providerAuthorityKey",
    "providerTerminalAttestationKey", "providerPayee", "providerControlProfileHash", "outcomeId",
    "method", "absoluteResourceUri", "bindingProfile", "requestSchemaHash", "responseSchemaHash",
    "canonicalizationProfile", "buyerIdentityPolicyHash", "daskiCommissionReceiver", "commissionBps",
    "termsHash", "refundPolicyHash", "screeningPolicyHash", "chainEvidencePolicyHash",
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
    "deliveryCommitment", "termsHash", "refundPolicyHash", "issuedAt", "validBefore", "offerNonce",
  ], "provider offer payload");
  requireClosedKeys(listing.terms as unknown as Record<string, unknown>, [
    "marketplaceTermsUrl", "marketplacePrivacyUrl", "providerLegalName", "providerTermsUrl",
    "providerPrivacyUrl",
  ], "listing terms");
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
    "refundSeconds",
  ], "deadline policy");
  requireClosedKeys(listing.refundPolicy as unknown as Record<string, unknown>, [
    "buyerRequested", "requestDeadlineSeconds", "executionReserveAddress",
    "releaseFailureDisposition", "providerFailureDisposition", "dispatchAmbiguityDisposition",
    "kycFailureDisposition",
  ], "refund policy");
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
    "providerAgentId", "providerAudience", "origin", "quoteUrl", "reserveUrl", "dispatchUrl",
    "dispatchStatusUrl", "lifecycleUrl", "tlsPolicy", "workloadAuthentication",
    "maxResponseBytes", "timeoutMs",
  ], "provider control profile payload");
  const origin = new URL(control.origin);
  if (origin.href !== `${origin.origin}/` || origin.protocol !== "https:" || origin.username || origin.password) {
    throw new Error("Provider control profile origin must be a credential-free HTTPS origin");
  }
  for (const [name, value] of Object.entries({
    quoteUrl: control.quoteUrl,
    reserveUrl: control.reserveUrl,
    dispatchUrl: control.dispatchUrl,
    dispatchStatusUrl: control.dispatchStatusUrl,
    lifecycleUrl: control.lifecycleUrl,
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
  const roleAddresses = [
    commitment.providerAuthorityKey,
    commitment.providerTerminalAttestationKey,
    commitment.providerPayee,
    listing.refundPolicy.executionReserveAddress,
    commitment.daskiCommissionReceiver,
  ].map((value) => getAddress(value).toLowerCase());
  if (new Set(roleAddresses).size !== roleAddresses.length) {
    throw new Error("Listing authority, payment, terminal, and refund roles must be distinct");
  }
  if (canonicalHash(listing.refundPolicy) !== commitment.refundPolicyHash) {
    throw new Error("Refund policy content hash mismatch");
  }
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
  if (
    listing.refundPolicy.releaseFailureDisposition !== "legal_hold" ||
    listing.refundPolicy.providerFailureDisposition !== "refund_due" ||
    listing.refundPolicy.dispatchAmbiguityDisposition !== "refund_due" ||
    listing.refundPolicy.kycFailureDisposition !== "refund_due" ||
    !Number.isSafeInteger(listing.refundPolicy.requestDeadlineSeconds) ||
    listing.refundPolicy.requestDeadlineSeconds < 30
  ) throw new Error("Refund failure dispositions are unsupported or invalid");
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
    offer.termsHash !== commitment.termsHash ||
    offer.refundPolicyHash !== commitment.refundPolicyHash
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
