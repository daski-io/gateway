import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// A seller's endpoint host resolves nowhere: the provider transport's lookup
// answers one fixed public address, and its calls stop at the seller below.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));

import { loadConfig } from "../src/config.js";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { REVIEWED_USDC_DOMAINS } from "../src/payment/usdcDomain.js";
import { createStandardApp, type StandardAppBundle } from "../src/standardRail/app.js";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { loadStandardRailConfig } from "../src/standardRail/config.js";
import { embeddedReleaseCapabilities } from "../src/standardRail/releaseCapabilities.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type {
  ProviderControlProfileV1, SignedEnvelope, StandardOrderRecord, StandardRailDispatchV2, StandardRailManifest,
} from "../src/standardRail/types.js";

// Control profiles across gateway starts. A gateway reads its manifest once,
// when it starts, and stores every envelope of it; nothing deletes a stored
// profile. Each test starts the gateway in this process over one database, as
// src/index.ts does (createStandardApp; no background work is started), with
// manifests that differ in the control profiles they carry:
//
// - The release-controls capabilities answer lists the profiles of the
//   manifest the answering process started with (controlProfiles), while
//   /public/v2/artifacts keeps answering a profile an earlier start stored.
//   Its answers are the shared fixture test/fixtures/release-capabilities-answer.json.
// - A paid order whose seller's profile has left the manifest is dispatched
//   from the listing stored with it, under that profile's hash.
// - A manifest carrying two audiences for one seller starts, and a retirement
//   for that seller is refused.
//
// Everything is synthetic: label-derived keys, .example hosts, fixed signing
// times. Regenerate the fixture after an intentional change to the answer:
//   UPDATE_RELEASE_CAPABILITIES_ANSWER=1 npx vitest run test/carriedControlProfilesPostgres.test.ts

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const update = process.env.UPDATE_RELEASE_CAPABILITIES_ANSWER === "1";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "release-capabilities-answer.json");
const GENERATOR = "test/carriedControlProfilesPostgres.test.ts " +
  "(UPDATE_RELEASE_CAPABILITIES_ANSWER=1 npx vitest run test/carriedControlProfilesPostgres.test.ts)";

// ---------------------------------------------------------------------------
// Synthetic identities.

const keyLabel = (name: string) => `daski capabilities-answer fixture key: ${name} (test only)`;
const syntheticHash = (name: string): Hex => keccak256(stringToHex(`daski capabilities-answer fixture: ${name}`));
const syntheticAddress = (name: string): Address => getAddress(`0x${syntheticHash(name).slice(-40)}`);
const KEYS = {
  manifestSigner: keccak256(stringToHex(keyLabel("manifest signer"))),
  gateway: keccak256(stringToHex(keyLabel("gateway"))),
  managedProviderWallet: keccak256(stringToHex(keyLabel("managed provider wallet"))),
  sellerWallet: keccak256(stringToHex(keyLabel("seller wallet"))),
  sellerNextWallet: keccak256(stringToHex(keyLabel("seller next wallet"))),
  payer: keccak256(stringToHex(keyLabel("payer"))),
};
const seller = privateKeyToAccount(KEYS.sellerWallet);

const ENVIRONMENT = "testnet";
const CHAIN_ID = 84_532;
const GATEWAY_AUDIENCE = "https://gateway.example";
const FACILITATOR_URL = "https://facilitator.example";
const OPERATOR_TOKEN = "capabilities-answer-test-operator-token-000000";
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
/** Every envelope is signed at one fixed instant and stays valid until 2100, so the set signs the same bytes on every run. */
const ISSUED_AT = 1_790_000_000;
const VALID_BEFORE = 4_102_444_800;
const DEPLOYMENTS = {
  first: "00000000-0000-4000-8000-0000000000d1",
  second: "00000000-0000-4000-8000-0000000000d2",
};
/** The two build-identity values of an answer, replaced in the fixture. */
const PLACEHOLDERS = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  artifactManifestHash: `sha256:${"0".repeat(64)}`,
};

/** A provider admitted for servicing, on its own origin. */
const MANAGED = "41";
const MANAGED_ORIGIN = "https://provider.example";
/** A seller with a control profile only, under its own path on a shared sellers' origin. */
const SELLER = "9001";
const SELLERS_ORIGIN = "https://sellers.example";
const SELLERS_NEXT_ORIGIN = "https://sellers-next.example";

// ---------------------------------------------------------------------------
// Manifests.

type Envelope = SignedEnvelope<unknown, 1 | 2>;
function envelope(artifactType: string, payload: object): Promise<Envelope> {
  return signEnvelope({
    artifactType, schemaVersion: Number(artifactType.match(/V([0-9]+)$/)![1]) as 1 | 2,
    environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE, signerKeyId: "gateway-protocol",
    account: privateKeyToAccount(KEYS.manifestSigner), issuedAt: ISSUED_AT, validBefore: VALID_BEFORE, payload,
  });
}
type Profile = SignedEnvelope<ProviderControlProfileV1>;
const profile = (payload: ProviderControlProfileV1) => envelope("ProviderControlProfileV1", payload) as Promise<Profile>;

function profilePayload(args: {
  providerAgentId: string; origin: string; base: string; key: Hex; servicingProfileEpoch: number;
}): ProviderControlProfileV1 {
  return {
    providerAgentId: args.providerAgentId,
    providerAudience: `${args.origin}/`,
    origin: args.origin,
    quoteUrl: `${args.base}/standard-rail/quote`,
    dispatchUrl: `${args.base}/standard-rail/dispatch`,
    dispatchStatusUrl: `${args.base}/standard-rail/dispatch/status`,
    lifecycleUrl: `${args.base}/standard-rail/lifecycle`,
    assetQueryUrl: `${args.base}/standard-rail/assets/query`,
    assetActionUrl: `${args.base}/standard-rail/assets/action`,
    assetResponseKeyId: "provider-wallet",
    assetResponseKey: privateKeyToAccount(args.key).address,
    servicingProfileEpoch: args.servicingProfileEpoch,
    tlsPolicy: "webpki-v1",
    workloadAuthentication: "signed-envelopes-v1",
    maxResponseBytes: 524_288,
    timeoutMs: 90_000,
  };
}

interface Manifests {
  managedProfile: Profile;
  managedAdmission: Envelope;
  /** The seller's profile: the one a removal takes out. */
  sellerProfile: Profile;
  /** A second profile of the seller, on another host and so another audience. */
  sellerOtherAudience: Profile;
  /** The managed provider and the seller. */
  withSeller: StandardRailManifest;
  /** The same manifest less the seller's profile. */
  withoutSeller: StandardRailManifest;
  /** The managed provider and both of the seller's profiles. */
  sellerOnTwoAudiences: StandardRailManifest;
}

async function manifests(): Promise<Manifests> {
  const token = REVIEWED_USDC_DOMAINS[CHAIN_ID].address;
  const allowedExtensionSetHash = syntheticHash("allowed extension set");
  const facilitatorProfile = await envelope("FacilitatorProfileV1", {
    profileEpoch: "1", profileId: "capabilities-answer-v1", baseUrl: FACILITATOR_URL, scheme: "exact",
    network: `eip155:${CHAIN_ID}`, asset: token, assetTransferMethod: "eip3009", authenticationMethod: "cdp-jwt-v1",
    credentialPolicyHash: syntheticHash("credential policy"), tlsPolicyHash: syntheticHash("tls policy"),
    allowedExtensionSetHash, settlementCalldataPolicyHash: syntheticHash("settlement calldata policy"),
    verifyTimeout: 10_000, settleTimeout: 30_000, responseSchemaHash: syntheticHash("response schema"),
    screeningPolicyHash: syntheticHash("screening policy"), evidenceAdapterHash: syntheticHash("evidence adapter"),
    activatedAt: ISSUED_AT, admissionValidBefore: VALID_BEFORE - 86_400, recoveryValidBefore: VALID_BEFORE,
  });
  const rail = {
    facilitatorProfile,
    railCapabilityRequirements: await envelope("RailCapabilityRequirementsV1", {
      requirementId: "capabilities-answer-v1", scheme: "exact", network: `eip155:${CHAIN_ID}`, asset: token,
      assetTransferMethod: "eip3009", authenticatedResponseEvidence: "cdp-jwt-v1",
      screeningCoverage: "gateway-and-facilitator-v1", calldataSemantics: "transferWithAuthorization-v1",
      allowedExtensionSetHash,
    }),
    activeRailProfile: await envelope("ActiveRailProfileV1", {
      railEpoch: "1", facilitatorProfileHash: canonicalHash(facilitatorProfile), priorRailEpoch: "0",
      priorActiveRailProfileHash: ZERO_HASH, environment: ENVIRONMENT, chainId: CHAIN_ID, activatedAt: ISSUED_AT,
      admissionValidBefore: VALID_BEFORE - 86_400, recoveryValidBefore: VALID_BEFORE,
    }),
    chainEvidencePolicy: await envelope("ChainEvidencePolicyV2", {
      policyId: "capabilities-answer-v1", canonicalToken: token,
      canonicalTokenRuntimeCodeHash: syntheticHash("token runtime code"),
      tokenImplementationAddress: syntheticAddress("token implementation"),
      tokenImplementationRuntimeCodeHash: syntheticHash("token implementation runtime code"),
      tokenImplementationSlot: syntheticHash("token implementation slot"),
      tokenDomainSeparator: REVIEWED_USDC_DOMAINS[CHAIN_ID].domainSeparator,
      maximumSourceLagBlocks: 10, finalityBlockTimeSeconds: 2, maximumLogPageEvents: 1_000,
    }),
  };
  const managedProfile = await profile(profilePayload({
    providerAgentId: MANAGED, origin: MANAGED_ORIGIN, base: MANAGED_ORIGIN, key: KEYS.managedProviderWallet,
    servicingProfileEpoch: 1,
  }));
  const actionCatalogSchemaHash = syntheticHash("action catalog schema");
  const managedCatalog = await envelope("ProviderAssetActionCatalogV1", {
    providerAgentId: MANAGED, providerControlProfileHash: canonicalHash(managedProfile), servicingProfileEpoch: 1,
    actionCatalogSchemaHash, actionCatalogEpoch: 1, actions: [],
  });
  const managedAdmission = await envelope("ProviderServicingAdmissionV1", {
    providerAgentId: MANAGED, providerControlProfileHash: canonicalHash(managedProfile), servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(managedCatalog), actionCatalogSchemaHash, actionCatalogEpoch: 1,
    servicingEnabled: true, previousAdmissionHash: ZERO_HASH, validFrom: ISSUED_AT, validBefore: VALID_BEFORE,
  });
  const sellerProfile = await profile(profilePayload({
    providerAgentId: SELLER, origin: SELLERS_ORIGIN, base: `${SELLERS_ORIGIN}/p/${SELLER}`, key: KEYS.sellerWallet,
    servicingProfileEpoch: 1,
  }));
  const sellerOtherAudience = await profile(profilePayload({
    providerAgentId: SELLER, origin: SELLERS_NEXT_ORIGIN, base: `${SELLERS_NEXT_ORIGIN}/p/${SELLER}`,
    key: KEYS.sellerNextWallet, servicingProfileEpoch: 2,
  }));
  const manifest = (providerControlProfiles: Profile[]) => ({
    ...rail, servicingAdmissions: [managedAdmission], actionCatalogs: [managedCatalog], providerControlProfiles,
  }) as unknown as StandardRailManifest;
  return {
    managedProfile, managedAdmission, sellerProfile, sellerOtherAudience,
    withSeller: manifest([managedProfile, sellerProfile]),
    withoutSeller: manifest([managedProfile]),
    sellerOnTwoAudiences: manifest([managedProfile, sellerProfile, sellerOtherAudience]),
  };
}

// ---------------------------------------------------------------------------
// One database, and gateways started over it.

/**
 * A migrated schema in which the managed provider's genesis admission is
 * recorded current, as a serving gateway's background activation leaves it.
 */
async function database(m: Manifests) {
  const schema = `carried_profiles_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 8 });
  await runMigrations(pool);
  const admission = m.managedAdmission as SignedEnvelope<{ providerControlProfileHash: Hex; validBefore: number }>;
  await pool.query(`INSERT INTO standard_provider_servicing_admissions
    (provider_agent_id,admission_hash,profile_hash,canonical_admission,current,valid_before)
    VALUES ($1,$2,$3,$4,true,to_timestamp($5))`, [MANAGED, bytes(canonicalHash(admission)),
    bytes(admission.payload.providerControlProfileHash), admission, admission.payload.validBefore]);
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
    },
  };
}

const zip = (value: string) => `gzip-base64:${gzipSync(value).toString("base64")}`;
const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");

/** The variables of a gateway that starts with this manifest; every value is synthetic. */
function environment(manifest: StandardRailManifest): NodeJS.ProcessEnv {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const creationCode = "0x60046000";
  return {
    NODE_ENV: "test", CHAIN_ID: String(CHAIN_ID), CHAIN_MODE: "live", MCP_ENABLED: "false",
    DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
    PUBLIC_URL: GATEWAY_AUDIENCE, STANDARD_RAIL_GATEWAY_AUDIENCE: GATEWAY_AUDIENCE, STANDARD_RAIL_ENVIRONMENT: ENVIRONMENT,
    FACILITATOR_PRIVATE_KEY: KEYS.gateway, STANDARD_RAIL_ENCRYPTION_KEY: "22".repeat(32),
    CDP_API_KEY_ID: "capabilities-answer-test",
    CDP_API_KEY_SECRET: Buffer.concat([Buffer.from(key.d!, "base64url"), Buffer.from(key.x!, "base64url")]).toString("base64"),
    CDP_FACILITATOR_BASE_URL: FACILITATOR_URL, BASE_RPC_URL: "https://rpc.example",
    STANDARD_RAIL_MANIFEST_JSON: zip(JSON.stringify(manifest)),
    STANDARD_RAIL_TRUSTED_SIGNERS_JSON: JSON.stringify({
      "gateway-protocol": privateKeyToAccount(KEYS.manifestSigner).address,
    }),
    STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH: syntheticHash("splitter factory runtime code"),
    STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH: keccak256(creationCode),
    STANDARD_RAIL_SPLITTER_CREATION_CODE: zip(creationCode),
    STANDARD_RAIL_SPLITTER_FACTORY: syntheticAddress("splitter factory"),
    STANDARD_RAIL_COMMISSION_RECEIVER: syntheticAddress("commission receiver"), STANDARD_RAIL_COMMISSION_BPS: "250",
    STANDARD_RAIL_SANCTIONS_ORACLE: syntheticAddress("sanctions oracle"),
    STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH: syntheticHash("sanctions oracle runtime code"),
    SANCTIONS_ORACLE_ADDRESS: syntheticAddress("sanctions oracle"), SANCTIONS_ORACLE_MODE: "production",
    IDENTITY_REGISTRY_ADDRESS: syntheticAddress("identity registry"), AGENT_INDEX_ADDRESS: syntheticAddress("agent index"),
    PROVIDER_REGISTRY_ADDRESS: syntheticAddress("provider registry"),
    SERVICE_REGISTRY_ADDRESS: syntheticAddress("service registry"),
    VALIDATION_REGISTRY_ADDRESS: syntheticAddress("validation registry"),
    REPUTATION_STORAGE_ADDRESS: syntheticAddress("reputation storage"),
    EAS_ADDRESS: syntheticAddress("eas"), EAS_OUTCOME_SCHEMA_UID: syntheticHash("outcome schema"),
    EAS_CONFIRMATION_SCHEMA_UID: syntheticHash("confirmation schema"),
    CATALOG_OPERATOR_TOKEN: OPERATOR_TOKEN,
  };
}

interface Gateway {
  url: string;
  service: StandardRailService;
  stop(): Promise<void>;
}
const running: Gateway[] = [];

/**
 * A gateway started with this manifest over the pool's schema, serving HTTP
 * on a loopback port. `sellerFetch` stands in for the network to sellers.
 */
async function startGateway(pool: Pool, manifest: StandardRailManifest, sellerFetch?: typeof fetch): Promise<Gateway> {
  const env = environment(manifest);
  const initialize = StandardRailService.prototype.initialize;
  let service: StandardRailService | undefined;
  const captured = vi.spyOn(StandardRailService.prototype, "initialize")
    .mockImplementation(async function (this: StandardRailService) {
      service = this;
      return initialize.call(this);
    });
  let bundle: StandardAppBundle;
  try {
    bundle = await createStandardApp({
      config: loadConfig(env), standardRailConfig: loadStandardRailConfig(env), pool, a2aFetch: sellerFetch,
    });
  } finally {
    captured.mockRestore();
  }
  const server = bundle.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const gateway: Gateway = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    service: service!,
    async stop() {
      const index = running.indexOf(gateway);
      if (index < 0) return;
      running.splice(index, 1);
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await bundle.shutdown(closed);
    },
  };
  running.push(gateway);
  return gateway;
}

async function stopAll(): Promise<void> {
  for (const gateway of [...running]) await gateway.stop();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await stopAll();
});

type Answer = Record<string, unknown> & { controlProfiles: ControlProfileRow[] };
interface ControlProfileRow {
  providerAgentId: string;
  profileHash: Hex;
  servicingProfileEpoch: number;
  assetResponseKey: string;
  providerAudience: string;
}

/** The release-controls capabilities answer, as the named deployment serves it. */
async function capabilities(gateway: Gateway, deploymentId: string): Promise<Answer> {
  vi.stubEnv("RAILWAY_DEPLOYMENT_ID", deploymentId);
  const response = await fetch(`${gateway.url}/internal/release/v1/capabilities`, {
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as Answer;
}

async function artifactStatus(gateway: Gateway, hash: Hex): Promise<number> {
  return (await fetch(`${gateway.url}/public/v2/artifacts/${hash}`)).status;
}

/** The row controlProfiles gives a profile. */
const row = (value: Profile): ControlProfileRow => ({
  providerAgentId: value.payload.providerAgentId,
  profileHash: canonicalHash(value),
  servicingProfileEpoch: value.payload.servicingProfileEpoch,
  assetResponseKey: value.payload.assetResponseKey,
  providerAudience: value.payload.providerAudience,
});

// ---------------------------------------------------------------------------
// The shared fixture.

const CONTRACT = "The gateway's release-controls capabilities answer, GET /internal/release/v1/capabilities " +
  "(catalog operator bearer token; Cache-Control: no-store), as two deployments of one gateway serve it over one " +
  "database: the first started with a manifest carrying a seller's control profile, the second with the same " +
  "manifest less that profile. Added by the gateway; the release engine copies this file byte for byte.";
const RULES = [
  "controlProfiles has one row per ProviderControlProfileV1 envelope of the manifest the answering process verified " +
    "when it started, in that manifest's order, and nothing else. It is never read from the database.",
  "profileHash is the canonical hash of the signed envelope: the hash GET /public/v2/artifacts/<hash> answers and an " +
    "order's stored listing names as providerControlProfileHash.",
  "GET /public/v2/artifacts/<hash> also answers 200 for every profile any earlier start over the same database stored, " +
    "and tells caches the answer is immutable. A 200 there says the hash is known, not that the answering deployment " +
    "carries it.",
  "deploymentId names the answering deployment (Railway's RAILWAY_DEPLOYMENT_ID), null outside Railway. While two " +
    "deployments answer, each lists its own manifest's profiles.",
  "controlProfileSelection comes from the image's release-capabilities.json. \"agent-wallet\": a provider the " +
    "manifest does not admit for servicing is sold through the carried profile whose assetResponseKey is the agent " +
    "wallet of the registration being sold, the highest servicingProfileEpoch of those. An image without the field " +
    "is treated as selecting the lowest epoch.",
  "An image built before controlProfiles answers without that field.",
  "artifactRoute is what GET /public/v2/artifacts/<hash> answered on that deployment for provider 41's profile, " +
    "seller 9001's profile and a hash no gateway started with.",
  "commit and artifactManifestHash identify the build. Here they are the placeholders below; the test that writes " +
    "this file checks them against the build and replaces exactly those two values.",
];

function fixtureAnswer(answer: Answer): Answer {
  const build = embeddedReleaseCapabilities();
  expect(answer.commit).toBe(build.artifact.commit);
  expect(answer.artifactManifestHash).toBe(build.artifactManifestHash);
  return { ...answer, ...PLACEHOLDERS };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// A paid order of the seller, as the gateway stored it at checkout.

const ORDER_ID = "ord_00000000-0000-4000-8000-000000009001";
const OUTCOME_ID = "create-note";
const SELLER_SERVICE_ID = syntheticHash("seller service");
const SELLER_LISTING_HASH = syntheticHash("seller listing");
const nowSeconds = () => Math.floor(Date.now() / 1_000);
const filled = (salt: number) => Buffer.alloc(32, salt);
const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
const depositEvidence = { kind: "deposit", orderId: ORDER_ID };
const releaseEvidence = { kind: "release", orderId: ORDER_ID,
  observations: [{ allocation: { providerNetAmount: "90", daskiCommissionAmount: "10", releaseSequence: "1" } }] };

/** The parts of the listing stored with the order that its dispatch reads, sold under `soldUnder`. */
function storedListing(soldUnder: Profile) {
  return {
    commitment: { payload: {
      providerAgentId: SELLER, serviceId: SELLER_SERVICE_ID, outcomeId: OUTCOME_ID, bindingProfile: "recipe-bound-v2",
      providerControlProfileHash: canonicalHash(soldUnder), providerAuthorityKey: soldUnder.payload.assetResponseKey,
      providerTerminalAttestationKey: soldUnder.payload.assetResponseKey,
      providerPayee: syntheticAddress("seller payee"), daskiCommissionReceiver: syntheticAddress("commission receiver"),
    } },
    manifest: { payload: { splitterAddress: syntheticAddress("seller splitter") } },
    providerOwner: syntheticAddress("seller owner"), providerAgentWallet: soldUnder.payload.assetResponseKey,
    screeningPolicy: { providerControlledWallets: [] },
    providerControlProfile: soldUnder,
    purchaseReadiness: null,
    deadlinePolicy: { dispatchSeconds: 300, fulfillmentSeconds: 30 * 86_400 },
  };
}

/** A paid order whose deposit and release are proven, a minute after its release, not yet dispatched. */
async function seedPaidOrder(pool: Pool, soldUnder: Profile): Promise<void> {
  const handle = "carried-profiles-order";
  const deposit = { transactionHash: hex(filled(8)), blockHash: hex(filled(13)), evidenceHash: canonicalHash(depositEvidence) };
  const release = { transactionHash: hex(filled(9)), blockHash: hex(filled(14)), evidenceHash: canonicalHash(releaseEvidence) };
  await pool.query(`INSERT INTO standard_orders (
    order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
    canonical_request,order_nonce,intent_id,authorization_key,payment_payload_hash,payer,gross_amount,
    provider_net_amount,daski_commission_amount,settlement_tx_hash,deposit_evidence_hash,release_tx_hash,
    release_evidence_hash,rail_epoch,listing_epoch,expires_at)
    VALUES ($1,$2,$3,$4,'RELEASE_FINAL',$5,$6,'recipe-bound-v2',$7,$8,$9,$10,$11,$12,'{}',$13,$14,$15,$16,$17,
      100,90,10,$18,$19,$20,$21,1,1,now()+interval '1 hour')`,
  [ORDER_ID, filled(1), handle, createHash("sha256").update(handle).digest(), SELLER, OUTCOME_ID,
    bytes(SELLER_LISTING_HASH), filled(2), storedListing(soldUnder), filled(3),
    { artifactType: "QuoteV1", payload: { validBefore: nowSeconds() - 60 } }, filled(4), filled(5),
    "int_00000000-0000-4000-8000-000000009001", filled(6), filled(7), privateKeyToAccount(KEYS.payer).address,
    deposit.transactionHash, bytes(deposit.evidenceHash), release.transactionHash, bytes(release.evidenceHash)]);
  for (const [kind, proof, canonical, block] of [
    ["deposit", deposit, depositEvidence, 100], ["release", release, releaseEvidence, 101],
  ] as const) {
    await pool.query(`INSERT INTO standard_chain_evidence (evidence_hash,order_id,evidence_kind,chain_id,block_number,
      block_hash,transaction_hash,transaction_index,log_index,source_fingerprints,canonical_evidence,observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,2,'["rpc-a"]',$8,now()-interval '1 minute')`,
    [bytes(proof.evidenceHash), ORDER_ID, kind, CHAIN_ID, block, proof.blockHash, proof.transactionHash, canonical]);
  }
}

/** The seller's endpoint: accepts a dispatch and answers it signed with the wallet its stored listing names. */
function sellerEndpoint() {
  const received: Array<{ url: string; dispatch: SignedEnvelope<StandardRailDispatchV2, 2> }> = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { dispatch?: SignedEnvelope<StandardRailDispatchV2, 2> };
    if (init?.method !== "POST" || !body.dispatch) return Response.json({ error: "unexpected" }, { status: 500 });
    received.push({ url, dispatch: body.dispatch });
    const answer = {
      taskId: "task-9001", dispatchHash: canonicalHash(body.dispatch), state: "working",
      operations: { schemaVersion: 1, revision: 0, observedAt: nowSeconds(), fulfillment: null, support: null, recovery: null },
    };
    return Response.json({ ...answer, signature: await seller.signMessage({ message: { raw: canonicalHash(answer) } }) });
  };
  return { received, fetch: fetchFn as typeof fetch };
}

// ---------------------------------------------------------------------------
// Retirements.

/** A listing of the provider that can be retired: it has one unsettled order and nothing open. */
async function retirableListing(pool: Pool, providerAgentId: string, salt: number) {
  const scope = { kind: "listing", providerAgentId, serviceId: syntheticHash(`service of ${providerAgentId}`),
    listingManifestHash: syntheticHash(`retired listing of ${providerAgentId}`) };
  await pool.query(`INSERT INTO standard_orders
    (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
    canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,listing_epoch,expires_at)
    VALUES($1,$2,$1,$2,'NOT_SETTLED',$3,'outcome','recipe-bound-v2',$4,$2,$5,$2,'{}',$2,'{}',$2,$6,1000000,1,1,
      now()-interval '1 day')`,
  [`unsettled-${providerAgentId}`, filled(salt), providerAgentId, bytes(scope.listingManifestHash),
    { commitment: { payload: { serviceId: scope.serviceId } } }, `int_${randomUUID()}`]);
  return scope;
}

async function retire(gateway: Gateway, scope: object, requestId: string) {
  const response = await fetch(`${gateway.url}/internal/release/v1/retirements`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...scope, requestId }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function retirementState(gateway: Gateway, scope: Record<string, string>) {
  const response = await fetch(`${gateway.url}/internal/release/v1/retirements?${new URLSearchParams(scope)}`, {
    headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as { retired: boolean };
}

// ---------------------------------------------------------------------------

describe("control profiles across gateway starts (postgres)", () => {
  it("lists only the profiles of the manifest a deployment started with, while the artifact route remembers every stored one", async () => {
    const m = await manifests();
    const db = await database(m);
    try {
      const sellerHash = canonicalHash(m.sellerProfile);
      const managedHash = canonicalHash(m.managedProfile);
      const unknownHash = syntheticHash("a profile no gateway started with");

      // A first deployment starts with the seller's profile.
      const first = await startGateway(db.pool, m.withSeller);
      const firstAnswer = await capabilities(first, DEPLOYMENTS.first);
      expect(firstAnswer.deploymentId).toBe(DEPLOYMENTS.first);
      expect(firstAnswer.controlProfiles).toEqual([row(m.managedProfile), row(m.sellerProfile)]);
      expect(firstAnswer.controlProfileSelection).toBe("agent-wallet");
      const firstArtifacts = { [managedHash]: await artifactStatus(first, managedHash),
        [sellerHash]: await artifactStatus(first, sellerHash), [unknownHash]: await artifactStatus(first, unknownHash) };
      expect(firstArtifacts).toEqual({ [managedHash]: 200, [sellerHash]: 200, [unknownHash]: 404 });

      // A second deployment starts over the same database with the profile removed.
      const second = await startGateway(db.pool, m.withoutSeller);
      const secondAnswer = await capabilities(second, DEPLOYMENTS.second);
      expect(secondAnswer.deploymentId).toBe(DEPLOYMENTS.second);
      expect(secondAnswer.controlProfiles).toEqual([row(m.managedProfile)]);
      expect(secondAnswer.controlProfiles.map((item) => item.profileHash)).not.toContain(sellerHash);
      // Its artifact route still answers the removed profile from the database, as immutable.
      const removed = await fetch(`${second.url}/public/v2/artifacts/${sellerHash}`);
      expect(removed.status).toBe(200);
      expect(removed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await removed.json()).toEqual(m.sellerProfile);
      const secondArtifacts = { [managedHash]: await artifactStatus(second, managedHash),
        [sellerHash]: await artifactStatus(second, sellerHash), [unknownHash]: await artifactStatus(second, unknownHash) };
      expect(secondArtifacts).toEqual({ [managedHash]: 200, [sellerHash]: 200, [unknownHash]: 404 });
      const stored = await db.pool.query("SELECT 1 FROM standard_rail_artifacts WHERE artifact_hash=$1", [bytes(sellerHash)]);
      expect(stored.rowCount).toBe(1);

      // While both answer, each lists its own manifest's profiles.
      expect((await capabilities(first, DEPLOYMENTS.first)).controlProfiles).toEqual(firstAnswer.controlProfiles);

      // Everything else in the answer is unchanged by the field.
      for (const answer of [firstAnswer, secondAnswer]) {
        expect(answer).toMatchObject({ schemaVersion: 1, role: "gateway", network: `eip155:${CHAIN_ID}`,
          executableListings: [], runtimeMappings: [], retirements: [] });
        expect(answer.carriedAdmissions).toEqual([expect.objectContaining({
          providerAgentId: MANAGED, admissionHash: canonicalHash(m.managedAdmission) })]);
        expect(answer.currentAdmissions).toEqual(answer.carriedAdmissions);
      }

      const fixture = {
        schemaVersion: 1,
        contract: CONTRACT,
        synthetic: true,
        owner: "daski-io/gateway",
        consumers: ["daski-io/deploy-mainnet"],
        generator: GENERATOR,
        route: {
          method: "GET", path: "/internal/release/v1/capabilities",
          authorization: "Bearer <catalog operator token>", cacheControl: "no-store",
        },
        controlProfileFields: ["providerAgentId", "profileHash", "servicingProfileEpoch", "assetResponseKey", "providerAudience"],
        rules: RULES,
        placeholders: PLACEHOLDERS,
        answers: [
          {
            name: "first deployment",
            started: "with a manifest carrying provider 41, admitted for servicing, and seller 9001's control profile",
            artifactRoute: firstArtifacts,
            answer: fixtureAnswer(firstAnswer),
          },
          {
            name: "second deployment",
            started: "over the same database, with the same manifest less seller 9001's control profile",
            artifactRoute: secondArtifacts,
            answer: fixtureAnswer(secondAnswer),
          },
        ],
      };
      if (update) writeFileSync(FIXTURE, serialize(fixture));
      expect(existsSync(FIXTURE), "run with UPDATE_RELEASE_CAPABILITIES_ANSWER=1").toBe(true);
      expect(readFileSync(FIXTURE, "utf8")).toBe(serialize(fixture));
    } finally {
      await stopAll();
      await db.close();
    }
  }, 60_000);

  it("dispatches a paid order from its stored listing after its seller's profile left the manifest", async () => {
    const m = await manifests();
    const db = await database(m);
    try {
      // The order was paid while a deployment carried the seller's profile.
      await (await startGateway(db.pool, m.withSeller)).stop();
      await seedPaidOrder(db.pool, m.sellerProfile);

      // The next deployment starts without it, and recovery dispatches the order.
      const endpoint = sellerEndpoint();
      const restarted = await startGateway(db.pool, m.withoutSeller, endpoint.fetch);
      const carried = (await capabilities(restarted, DEPLOYMENTS.second)).controlProfiles;
      expect(carried.map((item) => item.providerAgentId)).not.toContain(SELLER);
      await (restarted.service as unknown as { resumePaidOrder(order: StandardOrderRecord): Promise<void> })
        .resumePaidOrder({ orderId: ORDER_ID } as StandardOrderRecord);

      const profile = m.sellerProfile.payload;
      expect(endpoint.received).toHaveLength(1);
      const [{ url, dispatch }] = endpoint.received;
      expect(url).toBe(profile.dispatchUrl);
      expect(dispatch.audience).toBe(profile.providerAudience);
      expect(dispatch.payload).toMatchObject({
        providerControlProfileHash: canonicalHash(m.sellerProfile),
        providerAudience: profile.providerAudience,
        listingManifestHash: SELLER_LISTING_HASH,
        serviceId: SELLER_SERVICE_ID,
        orderId: ORDER_ID,
      });
      // The seller's answer, signed with the wallet the stored listing names, is accepted.
      const order = await db.pool.query<{ state: string; provider_task_id: string }>(
        "SELECT state,provider_task_id FROM standard_orders WHERE order_id=$1", [ORDER_ID]);
      expect(order.rows[0]).toEqual({ state: "DISPATCHED", provider_task_id: "task-9001" });
      const transitions = await db.pool.query<{ to_state: string }>(
        "SELECT to_state FROM standard_order_transitions WHERE order_id=$1 ORDER BY transition_id", [ORDER_ID]);
      expect(transitions.rows.map((item) => item.to_state)).toEqual(["DISPATCH_STARTED", "DISPATCHED"]);
    } finally {
      await stopAll();
      await db.close();
    }
  }, 60_000);

  it("starts with two audiences for one seller and refuses a retirement for that seller", async () => {
    const m = await manifests();
    const db = await database(m);
    try {
      const sellerScope = await retirableListing(db.pool, SELLER, 31);
      const managedScope = await retirableListing(db.pool, MANAGED, 32);
      expect(m.sellerProfile.payload.providerAudience).not.toBe(m.sellerOtherAudience.payload.providerAudience);

      // The manifest passes the start-up check and the gateway serves.
      const gateway = await startGateway(db.pool, m.sellerOnTwoAudiences);
      expect((await capabilities(gateway, DEPLOYMENTS.first)).controlProfiles)
        .toEqual([row(m.managedProfile), row(m.sellerProfile), row(m.sellerOtherAudience)]);

      expect(await retire(gateway, sellerScope, "retire-seller-listing")).toEqual({
        status: 409, body: { error: { code: "RETIREMENT_PROVIDER_AUDIENCE_REQUIRED" } },
      });
      expect((await retirementState(gateway, sellerScope)).retired).toBe(false);
      // A provider with one audience retires as before.
      const managed = await retire(gateway, managedScope, "retire-managed-listing");
      expect(managed.status).toBe(200);
      expect(managed.body).toMatchObject({ retired: true, receipt: { audience: m.managedProfile.payload.providerAudience } });

      // With one of the seller's profiles carried, the same retirement goes through.
      const restarted = await startGateway(db.pool, m.withSeller);
      const retired = await retire(restarted, sellerScope, "retire-seller-listing");
      expect(retired.status).toBe(200);
      expect(retired.body).toMatchObject({ retired: true, receipt: { audience: m.sellerProfile.payload.providerAudience } });
    } finally {
      await stopAll();
      await db.close();
    }
  }, 60_000);
});
