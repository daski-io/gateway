import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeServiceId } from "../../src/serviceRegistration/preparation.js";
import { canonicalHash } from "../../src/standardRail/canonical.js";
import { signEnvelope } from "../../src/standardRail/signing.js";
import type { ProviderControlProfileV1, SignedEnvelope, StandardRailManifest } from "../../src/standardRail/types.js";

/// The synthetic rail manifests in test/fixtures/rail-manifest-examples/, shared
/// by their generator (railManifestExamples.test.ts) and by the tests that sell
/// through them (sharedOriginProviders.test.ts). Each example is a complete
/// manifest signed with a key derived from a public label, at a fixed clock,
/// with the verdict the gateway's start-up check gives it. Nothing here is
/// private, live or production-derived.

export const RAIL_MANIFEST_EXAMPLES_DIR =
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rail-manifest-examples");
export const EXAMPLES_SCHEMA_VERSION = 1;
export const EXAMPLES_CONSUMERS = ["daski-io/deploy-mainnet"] as const;

// ---------------------------------------------------------------------------
// Synthetic identities and the fixed clock.

export const keyLabel = (name: string) => `daski rail-manifest example key: ${name} (test only)`;
const syntheticHash = (name: string): Hex => keccak256(stringToHex(`daski rail-manifest example: ${name}`));
const syntheticAddress = (name: string): Hex => getAddress(`0x${syntheticHash(name).slice(-40)}`);

export const KEY_ROLES = {
  manifestSigner: { signerKeyId: "gateway-protocol",
    role: "Trusted: signs every manifest envelope unless an example says otherwise" },
  untrustedSigner: { signerKeyId: null, role: "Trusted for no key ID: an envelope it signs must be refused" },
  sharedProviderWallet: { signerKeyId: null,
    role: "The one provider wallet both shared-origin control profiles name as assetResponseKey" },
  ownOriginProviderWallet: { signerKeyId: null, role: "The provider wallet of the provider on its own origin" },
} as const;
export type KeyName = keyof typeof KEY_ROLES;
export const PRIVATE_KEYS = Object.fromEntries(
  Object.keys(KEY_ROLES).map((name) => [name, keccak256(stringToHex(keyLabel(name)))]),
) as Record<KeyName, Hex>;
export const ADDRESSES = Object.fromEntries(
  Object.entries(PRIVATE_KEYS).map(([name, key]) => [name, privateKeyToAccount(key).address]),
) as Record<KeyName, Hex>;

/** The instant (unix seconds) at which every verdict holds. */
export const NOW = 1_790_000_000;
const ISSUED_AT = NOW - 3_600;
const VALID_BEFORE = NOW + 180 * 86_400;

export const ENVIRONMENT = "testnet";
export const CHAIN_ID = 84_532;
export const GATEWAY_AUDIENCE = "https://gateway.example";
export const TRUST = {
  environment: ENVIRONMENT,
  chainId: CHAIN_ID,
  gatewayAudience: GATEWAY_AUDIENCE,
  trustedSigners: { "gateway-protocol": [ADDRESSES.manifestSigner] },
} as const;

// ---------------------------------------------------------------------------
// Two providers on one origin. The three texts below are exact: the origin has
// no trailing slash, the audience is the origin with one, and each provider's
// URLs lie under its own path. They are the texts the gateway stores from a
// provider card that names the same origin and audience (card.ts), so a
// profile and a stored card compare as equal strings.

export const SHARED_ORIGIN = "https://shared.example";
export const SHARED_AUDIENCE = "https://shared.example/";
export const providerBase = (providerAgentId: string) => `${SHARED_ORIGIN}/p/${providerAgentId}`;
/** Admitted for servicing, with an action catalog. Its id is a prefix of the other's. */
export const ADMITTED_PROVIDER = "701";
/** Carries a control profile only: no servicing admission, no action catalog. */
export const PROFILE_ONLY_PROVIDER = "7012";
/** On its own origin, written the other accepted way: origin with a slash, audience without. */
export const OWN_ORIGIN_PROVIDER = "42";
const OWN_ORIGIN = "https://provider.example";

export const SERVICE = { slug: "note-keeping", version: "1" } as const;
export const serviceIdOf = (providerAgentId: string) => computeServiceId(providerAgentId, SERVICE.slug, SERVICE.version);
export const TOKEN = syntheticAddress("token");

export function sharedOriginProfile(providerAgentId: string): ProviderControlProfileV1 {
  const base = providerBase(providerAgentId);
  return {
    providerAgentId,
    providerAudience: SHARED_AUDIENCE,
    origin: SHARED_ORIGIN,
    quoteUrl: `${base}/standard-rail/quote`,
    dispatchUrl: `${base}/standard-rail/dispatch`,
    dispatchStatusUrl: `${base}/standard-rail/dispatch/status`,
    lifecycleUrl: `${base}/standard-rail/lifecycle`,
    assetQueryUrl: `${base}/standard-rail/assets/query`,
    assetActionUrl: `${base}/standard-rail/assets/action`,
    assetResponseKeyId: "provider-wallet",
    assetResponseKey: ADDRESSES.sharedProviderWallet,
    servicingProfileEpoch: 1,
    tlsPolicy: "webpki-v1",
    workloadAuthentication: "signed-envelopes-v1",
    maxResponseBytes: 524_288,
    timeoutMs: 90_000,
  };
}

function ownOriginProfile(): ProviderControlProfileV1 {
  return {
    providerAgentId: OWN_ORIGIN_PROVIDER,
    providerAudience: OWN_ORIGIN,
    origin: `${OWN_ORIGIN}/`,
    quoteUrl: `${OWN_ORIGIN}/standard-rail/quote`,
    dispatchUrl: `${OWN_ORIGIN}/standard-rail/dispatch`,
    dispatchStatusUrl: `${OWN_ORIGIN}/standard-rail/dispatch/status`,
    lifecycleUrl: `${OWN_ORIGIN}/standard-rail/lifecycle`,
    assetQueryUrl: `${OWN_ORIGIN}/standard-rail/assets/query`,
    assetActionUrl: `${OWN_ORIGIN}/standard-rail/assets/action`,
    assetResponseKeyId: "provider-wallet",
    assetResponseKey: ADDRESSES.ownOriginProviderWallet,
    servicingProfileEpoch: 1,
    tlsPolicy: "webpki-v1",
    workloadAuthentication: "signed-envelopes-v1",
    maxResponseBytes: 524_288,
    timeoutMs: 90_000,
  };
}

// ---------------------------------------------------------------------------
// Signing. ECDSA here is deterministic (RFC 6979), so the set regenerates byte
// for byte.

// Refused examples are built on purpose from payloads the manifest types do not
// allow, so envelopes are typed by what they were signed over and a manifest is
// cast as a whole.
type Envelope<T = unknown> = SignedEnvelope<T, 1>;
interface Domain {
  key?: KeyName;
  signerKeyId?: string;
  chainId?: number;
  issuedAt?: number;
  validBefore?: number;
}

function envelope<T>(artifactType: string, payload: T, domain: Domain = {}): Promise<Envelope<T>> {
  return signEnvelope({
    artifactType,
    // The version the type name carries: 2 for ChainEvidencePolicyV2.
    schemaVersion: Number(artifactType.match(/V([0-9]+)$/)![1]) as 1,
    environment: ENVIRONMENT,
    chainId: domain.chainId ?? CHAIN_ID,
    audience: GATEWAY_AUDIENCE,
    signerKeyId: domain.signerKeyId ?? KEY_ROLES.manifestSigner.signerKeyId,
    account: privateKeyToAccount(PRIVATE_KEYS[domain.key ?? "manifestSigner"]),
    issuedAt: domain.issuedAt ?? ISSUED_AT,
    validBefore: domain.validBefore ?? VALID_BEFORE,
    payload,
  });
}

const controlProfile = (payload: object, domain: Domain = {}) =>
  envelope("ProviderControlProfileV1", payload as ProviderControlProfileV1, domain);

async function railArtifacts() {
  const allowedExtensionSetHash = syntheticHash("allowed extension set");
  const facilitatorProfile = await envelope("FacilitatorProfileV1", {
    profileEpoch: "1", profileId: "example-v1", baseUrl: "https://facilitator.example",
    scheme: "exact", network: `eip155:${CHAIN_ID}`, asset: TOKEN, assetTransferMethod: "eip3009",
    authenticationMethod: "cdp-jwt-v1", credentialPolicyHash: syntheticHash("credential policy"),
    tlsPolicyHash: syntheticHash("tls policy"), allowedExtensionSetHash,
    settlementCalldataPolicyHash: syntheticHash("settlement calldata policy"), verifyTimeout: 10_000,
    settleTimeout: 30_000, responseSchemaHash: syntheticHash("response schema"),
    screeningPolicyHash: syntheticHash("screening policy"), evidenceAdapterHash: syntheticHash("evidence adapter"),
    activatedAt: ISSUED_AT, admissionValidBefore: VALID_BEFORE - 30 * 86_400, recoveryValidBefore: VALID_BEFORE,
  });
  return {
    facilitatorProfile,
    railCapabilityRequirements: await envelope("RailCapabilityRequirementsV1", {
      requirementId: "example-v1", scheme: "exact", network: `eip155:${CHAIN_ID}`, asset: TOKEN,
      assetTransferMethod: "eip3009", authenticatedResponseEvidence: "cdp-jwt-v1",
      screeningCoverage: "gateway-and-facilitator-v1", calldataSemantics: "transferWithAuthorization-v1",
      allowedExtensionSetHash,
    }),
    activeRailProfile: await envelope("ActiveRailProfileV1", {
      railEpoch: "1", facilitatorProfileHash: canonicalHash(facilitatorProfile), priorRailEpoch: "0",
      priorActiveRailProfileHash: `0x${"00".repeat(32)}`, environment: ENVIRONMENT, chainId: CHAIN_ID,
      activatedAt: ISSUED_AT, admissionValidBefore: VALID_BEFORE - 30 * 86_400, recoveryValidBefore: VALID_BEFORE,
    }),
    chainEvidencePolicy: await envelope("ChainEvidencePolicyV2", {
      policyId: "example-v1", canonicalToken: TOKEN,
      canonicalTokenRuntimeCodeHash: syntheticHash("token runtime code"),
      tokenImplementationAddress: syntheticAddress("token implementation"),
      tokenImplementationRuntimeCodeHash: syntheticHash("token implementation runtime code"),
      tokenImplementationSlot: syntheticHash("token implementation slot"),
      tokenDomainSeparator: syntheticHash("token domain separator"),
      maximumSourceLagBlocks: 10, finalityBlockTimeSeconds: 2, maximumLogPageEvents: 1_000,
    }),
  };
}

/** One owner-only read action at the endpoint, and the catalog and genesis admission that bind it to the profile. */
async function servicing(profile: Envelope<ProviderControlProfileV1>, change: {
  endpoint?: string;
  actionDefinitionHash?: Hex;
  admission?: Record<string, unknown>;
} = {}) {
  const providerAgentId = profile.payload.providerAgentId;
  const emptyObject = { type: "object", properties: {}, additionalProperties: false };
  const definition = {
    providerAgentId, serviceId: serviceIdOf(providerAgentId), serviceSlug: SERVICE.slug, actionId: "read-note",
    assetType: "note", ownershipPolicy: "owner-only", destructive: false, requestSchema: emptyObject,
    responseSchema: emptyObject, confirmationSummarySchema: null, confirmationSummaryTemplate: null,
    endpoint: change.endpoint ?? profile.payload.assetActionUrl, replayPolicy: "stable-result",
    retentionSeconds: 3_600, validFrom: ISSUED_AT, validBefore: VALID_BEFORE,
  };
  const actionCatalogSchemaHash = syntheticHash("action catalog schema");
  const catalog = await envelope("ProviderAssetActionCatalogV1", {
    providerAgentId, providerControlProfileHash: canonicalHash(profile), servicingProfileEpoch: 1,
    actionCatalogSchemaHash, actionCatalogEpoch: 1,
    actions: [{ ...definition, actionDefinitionHash: change.actionDefinitionHash ?? canonicalHash(definition) }],
  });
  const admission = await envelope("ProviderServicingAdmissionV1", {
    providerAgentId, providerControlProfileHash: canonicalHash(profile), servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(catalog), actionCatalogSchemaHash, actionCatalogEpoch: 1,
    servicingEnabled: true, previousAdmissionHash: `0x${"00".repeat(32)}`, validFrom: ISSUED_AT,
    validBefore: VALID_BEFORE, ...change.admission,
  });
  return { catalog, admission };
}

// ---------------------------------------------------------------------------
// The examples.

export interface RailManifestExample {
  id: string;
  verdict: "accepted" | "refused";
  purpose: string;
  /** The exact message the gateway's manifest check refuses with; null when it accepts. */
  gatewayError: string | null;
  manifest: StandardRailManifest;
}

export interface RailManifestExamples {
  schemaVersion: number;
  synthetic: true;
  purpose: string;
  check: string;
  clock: { now: number; note: string };
  trust: typeof TRUST;
  keys: Record<string, unknown>;
  sharedOrigin: Record<string, unknown>;
  verdicts: Record<string, string>;
  examples: RailManifestExample[];
}

const INVALID_POLICY = "Provider control profile policy is invalid";
const INVALID_SIGNATURE = "ProviderControlProfileV1 artifact signature is invalid";
const OUTSIDE_WINDOW = "ProviderControlProfileV1 artifact is outside its validity window";
const UNBOUND_ADMISSION = "Servicing admission does not bind an active control profile and action catalog";
const offOrigin = (name: string) => `${name} must be a credential-free query-free URL on the pinned provider origin`;

export async function buildRailManifestExamples(): Promise<RailManifestExamples> {
  const rail = await railArtifacts();
  const admittedProfile = await controlProfile(sharedOriginProfile(ADMITTED_PROVIDER));
  const profileOnly = sharedOriginProfile(PROFILE_ONLY_PROVIDER);
  const profileOnlyProfile = await controlProfile(profileOnly);
  const admitted = await servicing(admittedProfile);
  const manifest = (parts: {
    servicingAdmissions?: Envelope[]; actionCatalogs?: Envelope[]; providerControlProfiles?: Envelope[];
  } = {}) => ({
    ...rail,
    servicingAdmissions: [admitted.admission],
    actionCatalogs: [admitted.catalog],
    providerControlProfiles: [admittedProfile, profileOnlyProfile],
    ...parts,
  }) as unknown as StandardRailManifest;

  const examples: RailManifestExample[] = [];
  const accepted = (id: string, purpose: string, value: StandardRailManifest) =>
    examples.push({ id: `accepted.${id}`, verdict: "accepted", purpose, gatewayError: null, manifest: value });
  const refused = (id: string, purpose: string, gatewayError: string, value: StandardRailManifest) =>
    examples.push({ id: `refused.${id}`, verdict: "refused", purpose, gatewayError, manifest: value });
  /** The shared-origin manifest with the profile-only provider's profile replaced. */
  const withProfile = async (payload: object, domain: Domain = {}) =>
    manifest({ providerControlProfiles: [admittedProfile, await controlProfile(payload, domain)] });

  accepted("shared-origin",
    "Two providers on one origin with one provider wallet and one audience, each under its own path. One is "
    + "admitted for servicing with an action catalog; the other carries a control profile only.", manifest());
  accepted("shared-origin-profiles-only",
    "The same two control profiles with no servicing admission and no action catalog at all: a profile needs neither.",
    manifest({ servicingAdmissions: [], actionCatalogs: [] }));
  const ownOrigin = await controlProfile(ownOriginProfile());
  const ownOriginServicing = await servicing(ownOrigin);
  accepted("own-origin-beside-shared-origin",
    "A provider on its own origin, written with a trailing slash and an audience without one, admitted for "
    + "servicing, beside two profile-only providers on the shared origin.",
    manifest({ servicingAdmissions: [ownOriginServicing.admission], actionCatalogs: [ownOriginServicing.catalog],
      providerControlProfiles: [ownOrigin, admittedProfile, profileOnlyProfile] }));

  refused("profile-origin-with-path", "A profile origin is a bare origin: the provider's path belongs in its URLs.",
    "Provider control profile origin must be a credential-free HTTPS origin",
    await withProfile({ ...profileOnly, origin: providerBase(PROFILE_ONLY_PROVIDER) }));
  refused("profile-url-on-another-origin", "Every URL of a profile lies on the profile's origin.", offOrigin("dispatchUrl"),
    await withProfile({ ...profileOnly,
      dispatchUrl: `https://other.example/p/${PROFILE_ONLY_PROVIDER}/standard-rail/dispatch` }));
  refused("profile-url-with-query", "A provider is told apart by its path, never by a query.", offOrigin("quoteUrl"),
    await withProfile({ ...profileOnly, quoteUrl: `${SHARED_ORIGIN}/standard-rail/quote?provider=${PROFILE_ONLY_PROVIDER}` }));
  refused("profile-duplicate-agent-epoch", "One agent carries at most one profile per servicing profile epoch.",
    INVALID_POLICY, manifest({ providerControlProfiles: [admittedProfile, profileOnlyProfile,
      await controlProfile({ ...profileOnly, timeoutMs: 60_000 })] }));
  refused("profile-agent-id-not-canonical", "The agent id is decimal text without a leading zero.", INVALID_POLICY,
    await withProfile({ ...sharedOriginProfile(`0${PROFILE_ONLY_PROVIDER}`) }));
  refused("profile-timeout-above-limit", "A provider timeout is at most 120,000 milliseconds.", INVALID_POLICY,
    await withProfile({ ...profileOnly, timeoutMs: 120_001 }));
  refused("profile-unknown-field", "A profile payload is closed: no field beyond the sixteen.",
    "provider control profile payload has unknown fields: providerPath",
    await withProfile({ ...profileOnly, providerPath: `/p/${PROFILE_ONLY_PROVIDER}` }));
  const { assetQueryUrl: _assetQueryUrl, ...withoutAssetQuery } = profileOnly;
  refused("profile-missing-field", "Both asset URLs are required of a provider that is never asked for assets.",
    "provider control profile payload is missing fields: assetQueryUrl", await withProfile(withoutAssetQuery));
  refused("profile-untrusted-signature", "The key ID is trusted; the key that signed is not listed for it.",
    INVALID_SIGNATURE, await withProfile(profileOnly, { key: "untrustedSigner" }));
  refused("profile-changed-after-signing", "The payload differs from the one the trusted key signed.", INVALID_SIGNATURE,
    manifest({ providerControlProfiles: [admittedProfile,
      { ...profileOnlyProfile, payload: { ...profileOnly, timeoutMs: 60_000 } }] }));
  refused("profile-unknown-signer-key-id", "No signer is trusted under the envelope's key ID.",
    "Unknown artifact signer provider-admission", await withProfile(profileOnly, { signerKeyId: "provider-admission" }));
  refused("profile-another-chain", "The envelope is signed for another chain.",
    "ProviderControlProfileV1 artifact domain mismatch", await withProfile(profileOnly, { chainId: 8_453 }));
  refused("profile-expired", "One profile expires before the rest of the manifest: validBefore is the clock's now.",
    OUTSIDE_WINDOW, await withProfile(profileOnly, { validBefore: NOW }));
  refused("profile-not-yet-valid", "One profile is issued a second after the clock's now.", OUTSIDE_WINDOW,
    await withProfile(profileOnly, { issuedAt: NOW + 1 }));
  refused("admission-without-carried-profile", "An admission must name a control profile the manifest carries.",
    UNBOUND_ADMISSION, manifest({ providerControlProfiles: [profileOnlyProfile] }));
  const borrowed = await servicing(admittedProfile, { admission: { providerAgentId: PROFILE_ONLY_PROVIDER } });
  refused("admission-borrows-another-agents-profile",
    "An admission for one agent names the profile and catalog of the other agent on the same origin.", UNBOUND_ADMISSION,
    manifest({ servicingAdmissions: [admitted.admission, borrowed.admission] }));
  const strayAction = await servicing(admittedProfile, { endpoint: profileOnly.assetActionUrl });
  refused("action-on-another-providers-path",
    "An admitted provider's action names the asset action URL of the other provider on the same origin.",
    "Action definition is outside its admitted provider service",
    manifest({ servicingAdmissions: [strayAction.admission], actionCatalogs: [strayAction.catalog] }));
  const forgedAction = await servicing(admittedProfile, { actionDefinitionHash: syntheticHash("another action definition") });
  refused("action-definition-hash-mismatch", "An action definition's hash is not the hash of the definition.",
    "Provider action definition is invalid",
    manifest({ servicingAdmissions: [forgedAction.admission], actionCatalogs: [forgedAction.catalog] }));

  return {
    schemaVersion: EXAMPLES_SCHEMA_VERSION,
    synthetic: true,
    purpose: "Complete standard-rail manifests with the verdict the gateway gives each when it starts.",
    check: "src/standardRail/artifacts.ts verifyStandardRailManifest(manifest, trust), with the clock at clock.now",
    clock: { now: NOW, note: "Unix seconds. An envelope is valid while issuedAt <= now < validBefore." },
    trust: TRUST,
    keys: {
      testOnly: true,
      warning: "Synthetic keys derived from public labels. They sign nothing real, hold no funds and must never be "
        + "configured for any network.",
      derivation: "privateKey = keccak256(utf8(label)); address = EIP-55 address of privateKey",
      signature: "EIP-191 personal_sign over the raw 32-byte keccak256 of the canonical JSON of the envelope without "
        + "its signature; deterministic (RFC 6979)",
      keys: Object.fromEntries(Object.entries(KEY_ROLES).map(([name, entry]) => [name, {
        label: keyLabel(name), ...(entry.signerKeyId ? { signerKeyId: entry.signerKeyId } : {}), role: entry.role,
        privateKey: PRIVATE_KEYS[name as KeyName], address: ADDRESSES[name as KeyName],
      }])),
    },
    sharedOrigin: {
      origin: SHARED_ORIGIN,
      providerAudience: SHARED_AUDIENCE,
      providerBase: providerBase("<providerAgentId>"),
      note: "Exact texts: the origin without a trailing slash, the audience with one, each provider's six URLs under "
        + "its own base. They are what the gateway stores from a provider card naming this origin and audience.",
      admittedProvider: ADMITTED_PROVIDER,
      profileOnlyProvider: PROFILE_ONLY_PROVIDER,
    },
    verdicts: {
      accepted: "The check resolves: a gateway given this manifest starts.",
      refused: "The check rejects with exactly gatewayError: a gateway given this manifest does not start. Every "
        + "refused example is accepted.shared-origin with the one defect its purpose names; every envelope the "
        + "defect does not concern keeps a valid signature.",
    },
    examples,
  };
}

/** The serialization every fixture file in this repository uses. */
export const serializeExamples = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
