import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Provider hosts resolve nowhere: the provider transport's lookup answers one
// fixed public address, and its calls stop at the providers below.
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:dns/promises")>(),
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
}));

import { loadConfig } from "../src/config.js";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { REVIEWED_USDC_DOMAINS } from "../src/payment/usdcDomain.js";
import { createStandardApp, type StandardAppBundle } from "../src/standardRail/app.js";
import { artifactPayloadHash, canonicalHash } from "../src/standardRail/canonical.js";
import { loadStandardRailConfig } from "../src/standardRail/config.js";
import { StandardRailService } from "../src/standardRail/service.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import type {
  ProviderControlProfileV1, ProviderWalletActionGrantV1, SignedEnvelope, StandardOrderRecord,
  StandardRailDispatchV2, StandardRailManifest,
} from "../src/standardRail/types.js";
import { deriveActionExecutionId } from "../src/standardRail/walletAuthorization.js";

// A gateway reads a manifest signed long before: the long-lived artifacts it
// carries (rail and facilitator profiles, rail capability requirements, chain
// evidence policy, control profiles, servicing admissions, action catalogs
// and their definitions) do not expire. The manifest here is laid out as the
// first rail windows were signed: 180-day envelopes from 2026-09-25 to
// 2027-03-24, admission closing on 2027-03-13 and recovery on 2027-03-23, the
// admission and every action definition ending with recovery. With the clock
// in April 2027 and in June 2032, past every one of those dates, a gateway
// started over Postgres in this process (createStandardApp, as src/index.ts
// does; no background work is started) starts, reports ready, admits a
// purchase, dispatches a paid order, and runs an owner's asset actions, while
// short-lived envelopes still expire and the rail's epoch chain still refuses
// a rollback or an equivocation.
//
// Everything is synthetic: label-derived keys, .example hosts. Only Date is
// faked; the database keeps its own clock.

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

const keyLabel = (name: string) => `daski long-lived rail fixture key: ${name} (test only)`;
const syntheticHash = (name: string): Hex => keccak256(stringToHex(`daski long-lived rail fixture: ${name}`));
const syntheticAddress = (name: string): Address => getAddress(`0x${syntheticHash(name).slice(-40)}`);
const KEYS = {
  manifestSigner: keccak256(stringToHex(keyLabel("manifest signer"))),
  gateway: keccak256(stringToHex(keyLabel("gateway"))),
  managedProviderWallet: keccak256(stringToHex(keyLabel("managed provider wallet"))),
  sellerWallet: keccak256(stringToHex(keyLabel("seller wallet"))),
  payer: keccak256(stringToHex(keyLabel("payer"))),
};
const managedWallet = privateKeyToAccount(KEYS.managedProviderWallet);
const seller = privateKeyToAccount(KEYS.sellerWallet);
const payer = privateKeyToAccount(KEYS.payer);

const ENVIRONMENT = "testnet";
const CHAIN_ID = 84_532;
const GATEWAY_AUDIENCE = "https://gateway.example";
const FACILITATOR_URL = "https://facilitator.example";
const OPERATOR_TOKEN = "long-lived-rail-test-operator-token-000000000";
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const DAY = 86_400;

/** The dates the manifest is signed with. */
const SIGNED_AT = Date.UTC(2026, 8, 25) / 1_000;
const WINDOW = {
  issuedAt: SIGNED_AT,
  validBefore: SIGNED_AT + 180 * DAY,
  admissionValidBefore: SIGNED_AT + 169 * DAY,
  recoveryValidBefore: SIGNED_AT + 179 * DAY,
};
/** Clocks past every date of the manifest. */
const CLOCKS = [
  ["2027-04-01", Date.UTC(2027, 3, 1) / 1_000],
  ["2032-06-01", Date.UTC(2032, 5, 1) / 1_000],
] as const;
/** What the release engine gives an artifact it signs: five years from its signing. */
const FIVE_YEARS = 5 * 365 * DAY;

/** A provider admitted for servicing, with two owner actions. */
const MANAGED = "41";
const MANAGED_ORIGIN = "https://provider.example";
/** A seller with a control profile only, under its own path on a sellers' origin. */
const SELLER = "9001";
const SELLERS_ORIGIN = "https://sellers.example";

// ---------------------------------------------------------------------------
// The manifest.

type Envelope = SignedEnvelope<unknown, 1 | 2>;
interface At { issuedAt: number; validBefore: number }
function envelope(artifactType: string, payload: object, at: At = WINDOW): Promise<Envelope> {
  return signEnvelope({
    artifactType, schemaVersion: Number(artifactType.match(/V([0-9]+)$/)![1]) as 1 | 2,
    environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE, signerKeyId: "gateway-protocol",
    account: privateKeyToAccount(KEYS.manifestSigner), issuedAt: at.issuedAt, validBefore: at.validBefore, payload,
  });
}
type Profile = SignedEnvelope<ProviderControlProfileV1>;

function profilePayload(providerAgentId: string, origin: string, base: string, key: Hex): ProviderControlProfileV1 {
  return {
    providerAgentId, providerAudience: `${origin}/`, origin,
    quoteUrl: `${base}/standard-rail/quote`, dispatchUrl: `${base}/standard-rail/dispatch`,
    dispatchStatusUrl: `${base}/standard-rail/dispatch/status`, lifecycleUrl: `${base}/standard-rail/lifecycle`,
    assetQueryUrl: `${base}/standard-rail/assets/query`, assetActionUrl: `${base}/standard-rail/assets/action`,
    assetResponseKeyId: "provider-wallet", assetResponseKey: privateKeyToAccount(key).address,
    servicingProfileEpoch: 1, tlsPolicy: "webpki-v1", workloadAuthentication: "signed-envelopes-v1",
    maxResponseBytes: 524_288, timeoutMs: 90_000,
  };
}

const NOTE_SERVICE = syntheticHash("note service");
const closed = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
function definition(actionId: string, destructive: boolean) {
  const preimage = {
    providerAgentId: MANAGED, serviceId: NOTE_SERVICE, serviceSlug: "notes", actionId, assetType: "note",
    ownershipPolicy: "owner-only", destructive, requestSchema: closed({}),
    responseSchema: closed({ text: { type: "string" } }),
    confirmationSummarySchema: destructive ? closed({ actionId: { type: "string" } }) : null,
    confirmationSummaryTemplate: destructive ? { actionId } : null,
    endpoint: `${MANAGED_ORIGIN}/standard-rail/assets/action`, replayPolicy: "stable-result", retentionSeconds: 3_600,
    validFrom: WINDOW.issuedAt, validBefore: WINDOW.recoveryValidBefore,
  };
  return { ...preimage, actionDefinitionHash: canonicalHash(preimage) };
}

/** A rail or facilitator profile's dates: the signed window's, or, for one signed at `at`, inside its envelope. */
const datesOf = (at: At) => at === WINDOW
  ? { activatedAt: WINDOW.issuedAt + 60, admissionValidBefore: WINDOW.admissionValidBefore,
    recoveryValidBefore: WINDOW.recoveryValidBefore }
  : { activatedAt: at.issuedAt, admissionValidBefore: at.validBefore - 2 * DAY, recoveryValidBefore: at.validBefore - DAY };

interface RailOptions { railEpoch?: string; prior?: Envelope; profileId?: string; at?: At }
/** The four rail envelopes; the requirements and the chain evidence policy are always the signed window's. */
async function rail({ railEpoch = "1", prior, profileId = "long-lived-v1", at = WINDOW }: RailOptions = {}) {
  const token = REVIEWED_USDC_DOMAINS[CHAIN_ID].address;
  const allowedExtensionSetHash = syntheticHash("allowed extension set");
  const dates = datesOf(at);
  const facilitatorProfile = await envelope("FacilitatorProfileV1", {
    profileEpoch: "1", profileId, baseUrl: FACILITATOR_URL, scheme: "exact",
    network: `eip155:${CHAIN_ID}`, asset: token, assetTransferMethod: "eip3009", authenticationMethod: "cdp-jwt-v1",
    credentialPolicyHash: syntheticHash("credential policy"), tlsPolicyHash: syntheticHash("tls policy"),
    allowedExtensionSetHash, settlementCalldataPolicyHash: syntheticHash("settlement calldata policy"),
    verifyTimeout: 10_000, settleTimeout: 30_000, responseSchemaHash: syntheticHash("response schema"),
    screeningPolicyHash: syntheticHash("screening policy"), evidenceAdapterHash: syntheticHash("evidence adapter"),
    ...dates,
  }, at);
  return {
    facilitatorProfile,
    railCapabilityRequirements: await envelope("RailCapabilityRequirementsV1", {
      requirementId: "long-lived-v1", scheme: "exact", network: `eip155:${CHAIN_ID}`, asset: token,
      assetTransferMethod: "eip3009", authenticatedResponseEvidence: "cdp-jwt-v1",
      screeningCoverage: "gateway-and-facilitator-v1", calldataSemantics: "transferWithAuthorization-v1",
      allowedExtensionSetHash,
    }),
    activeRailProfile: await envelope("ActiveRailProfileV1", {
      railEpoch, facilitatorProfileHash: canonicalHash(facilitatorProfile),
      priorRailEpoch: prior ? (prior.payload as { railEpoch: string }).railEpoch : "0",
      priorActiveRailProfileHash: prior ? canonicalHash(prior) : ZERO_HASH,
      environment: ENVIRONMENT, chainId: CHAIN_ID, ...dates,
    }, at),
    chainEvidencePolicy: await envelope("ChainEvidencePolicyV2", {
      policyId: "long-lived-v1", canonicalToken: token,
      canonicalTokenRuntimeCodeHash: syntheticHash("token runtime code"),
      tokenImplementationAddress: syntheticAddress("token implementation"),
      tokenImplementationRuntimeCodeHash: syntheticHash("token implementation runtime code"),
      tokenImplementationSlot: syntheticHash("token implementation slot"),
      tokenDomainSeparator: REVIEWED_USDC_DOMAINS[CHAIN_ID].domainSeparator,
      maximumSourceLagBlocks: 10, finalityBlockTimeSeconds: 2, maximumLogPageEvents: 1_000,
    }),
  };
}
interface Fixture {
  rail: Awaited<ReturnType<typeof rail>>;
  managedProfile: Profile;
  managedCatalog: Envelope;
  managedAdmission: SignedEnvelope<{ providerControlProfileHash: Hex; validBefore: number }>;
  sellerProfile: Profile;
  manifest: StandardRailManifest;
}

async function fixture(): Promise<Fixture> {
  const railArtifacts = await rail();
  const managedProfile = await envelope("ProviderControlProfileV1",
    profilePayload(MANAGED, MANAGED_ORIGIN, MANAGED_ORIGIN, KEYS.managedProviderWallet)) as Profile;
  const actionCatalogSchemaHash = syntheticHash("action catalog schema");
  const managedCatalog = await envelope("ProviderAssetActionCatalogV1", {
    providerAgentId: MANAGED, providerControlProfileHash: canonicalHash(managedProfile), servicingProfileEpoch: 1,
    actionCatalogSchemaHash, actionCatalogEpoch: 1,
    actions: [definition("read-note", false), definition("erase-note", true)],
  });
  const managedAdmission = await envelope("ProviderServicingAdmissionV1", {
    providerAgentId: MANAGED, providerControlProfileHash: canonicalHash(managedProfile), servicingProfileEpoch: 1,
    actionCatalogHash: canonicalHash(managedCatalog), actionCatalogSchemaHash, actionCatalogEpoch: 1,
    servicingEnabled: true, previousAdmissionHash: ZERO_HASH,
    validFrom: WINDOW.issuedAt, validBefore: WINDOW.recoveryValidBefore,
  }) as Fixture["managedAdmission"];
  const sellerProfile = await envelope("ProviderControlProfileV1",
    profilePayload(SELLER, SELLERS_ORIGIN, `${SELLERS_ORIGIN}/p/${SELLER}`, KEYS.sellerWallet)) as Profile;
  return {
    rail: railArtifacts, managedProfile, managedCatalog, managedAdmission, sellerProfile,
    manifest: {
      ...railArtifacts, servicingAdmissions: [managedAdmission], actionCatalogs: [managedCatalog],
      providerControlProfiles: [managedProfile, sellerProfile],
    } as unknown as StandardRailManifest,
  };
}

// ---------------------------------------------------------------------------
// One database, and gateways started over it.

const bytes = (value: Hex) => Buffer.from(value.slice(2), "hex");
const filled = (salt: number) => Buffer.alloc(32, salt);
const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;

/** A migrated schema in which the managed provider's admission is current, as background activation leaves it. */
async function database(f: Fixture) {
  const schema = `long_lived_rail_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 8 });
  await runMigrations(pool);
  const admission = f.managedAdmission;
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

function environment(manifest: StandardRailManifest): NodeJS.ProcessEnv {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const creationCode = "0x60046000";
  return {
    NODE_ENV: "test", CHAIN_ID: String(CHAIN_ID), CHAIN_MODE: "live", MCP_ENABLED: "false",
    DATABASE_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
    PUBLIC_URL: GATEWAY_AUDIENCE, STANDARD_RAIL_GATEWAY_AUDIENCE: GATEWAY_AUDIENCE, STANDARD_RAIL_ENVIRONMENT: ENVIRONMENT,
    FACILITATOR_PRIVATE_KEY: KEYS.gateway, STANDARD_RAIL_ENCRYPTION_KEY: "33".repeat(32),
    CDP_API_KEY_ID: "long-lived-rail-test",
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

interface Gateway { url: string; service: StandardRailService; stop(): Promise<void> }
const running: Gateway[] = [];

async function startGateway(pool: Pool, manifest: StandardRailManifest, providers?: typeof fetch): Promise<Gateway> {
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
      config: loadConfig(env), standardRailConfig: loadStandardRailConfig(env), pool, a2aFetch: providers,
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
      const closedServer = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await bundle.shutdown(closedServer);
    },
  };
  running.push(gateway);
  return gateway;
}

afterEach(async () => {
  for (const gateway of [...running]) await gateway.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Moves the clock to `seconds`; it keeps running from there. */
function setClock(seconds: number): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(seconds * 1_000);
}
const nowSeconds = () => Math.floor(Date.now() / 1_000);

// ---------------------------------------------------------------------------
// Orders, as the gateway stored them at checkout.

const ORDER_ID = "ord_00000000-0000-4000-8000-000000000441";
const OUTCOME_ID = "create-note";
const SELLER_SERVICE_ID = syntheticHash("seller service");
const SELLER_LISTING_HASH = syntheticHash("seller listing");
const depositEvidence = { kind: "deposit", orderId: ORDER_ID };
const releaseEvidence = { kind: "release", orderId: ORDER_ID,
  observations: [{ allocation: { providerNetAmount: "90", daskiCommissionAmount: "10", releaseSequence: "1" } }] };

/** A paid order of the seller whose deposit and release are proven, not yet dispatched. */
async function seedPaidOrder(pool: Pool, soldUnder: Profile): Promise<void> {
  const handle = "long-lived-rail-order";
  const listing = {
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
    deadlinePolicy: { dispatchSeconds: 300, fulfillmentSeconds: 30 * DAY },
  };
  const deposit = { transactionHash: hex(filled(8)), blockHash: hex(filled(13)), evidenceHash: canonicalHash(depositEvidence) };
  const release = { transactionHash: hex(filled(9)), blockHash: hex(filled(14)), evidenceHash: canonicalHash(releaseEvidence) };
  await pool.query(`INSERT INTO standard_orders (
    order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
    canonical_request,order_nonce,intent_id,authorization_key,payment_payload_hash,payer,gross_amount,
    provider_net_amount,daski_commission_amount,settlement_tx_hash,deposit_evidence_hash,release_tx_hash,
    release_evidence_hash,rail_epoch,listing_epoch,expires_at)
    VALUES ($1,$2,$3,$4,'RELEASE_FINAL',$5,$6,'recipe-bound-v2',$7,$8,$9,$10,$11,$12,'{}',$13,$14,$15,$16,$17,
      100,90,10,$18,$19,$20,$21,1,1,to_timestamp($22))`,
  [ORDER_ID, filled(1), handle, createHash("sha256").update(handle).digest(), SELLER, OUTCOME_ID,
    bytes(SELLER_LISTING_HASH), filled(2), listing, filled(3),
    { artifactType: "QuoteV1", payload: { validBefore: nowSeconds() - 60 } }, filled(4), filled(5),
    "int_00000000-0000-4000-8000-000000000441", filled(6), filled(7), payer.address,
    deposit.transactionHash, bytes(deposit.evidenceHash), release.transactionHash, bytes(release.evidenceHash),
    nowSeconds() + 3_600]);
  for (const [kind, proof, canonical, block] of [
    ["deposit", deposit, depositEvidence, 100], ["release", release, releaseEvidence, 101],
  ] as const) {
    await pool.query(`INSERT INTO standard_chain_evidence (evidence_hash,order_id,evidence_kind,chain_id,block_number,
      block_hash,transaction_hash,transaction_index,log_index,source_fingerprints,canonical_evidence,observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,2,'["rpc-a"]',$8,to_timestamp($9))`,
    [bytes(proof.evidenceHash), ORDER_ID, kind, CHAIN_ID, block, proof.blockHash, proof.transactionHash, canonical,
      nowSeconds() - 60]);
  }
}

/** An order of the payer with the managed provider past its deposit: what makes the payer an owner there. */
async function seedOwnership(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO standard_orders
    (order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
    listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
    canonical_request_hash,canonical_request,order_nonce,intent_id,payer,gross_amount,rail_epoch,listing_epoch,expires_at)
    VALUES($1,$2,$1,$2,'FULFILLED',$3,'outcome','recipe-bound-v2',$4,$2,'{}',$2,'{}',$2,'{}',$2,$5,$6,1000000,1,1,
      now()-interval '1 day')`,
  ["owned-note-order", filled(41), MANAGED, bytes(syntheticHash("managed listing")), `int_${randomUUID()}`,
    payer.address]);
}

// ---------------------------------------------------------------------------
// The providers: the seller answers a dispatch, the managed provider an asset action.

interface Providers {
  fetch: typeof fetch;
  dispatches: Array<{ url: string; dispatch: SignedEnvelope<StandardRailDispatchV2, 2> }>;
  grants: SignedEnvelope<ProviderWalletActionGrantV1>[];
  /** Whether the managed provider answers with an envelope already past its validBefore. */
  answer: { expired: boolean };
}

function providers(): Providers {
  const state: Providers = { dispatches: [], grants: [], answer: { expired: false }, fetch: undefined as never };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url === `${SELLERS_ORIGIN}/p/${SELLER}/standard-rail/dispatch`) {
      const dispatch = body.dispatch as SignedEnvelope<StandardRailDispatchV2, 2>;
      state.dispatches.push({ url, dispatch });
      const answer = {
        taskId: "task-441", dispatchHash: canonicalHash(dispatch), state: "working",
        operations: { schemaVersion: 1, revision: 0, observedAt: nowSeconds(), fulfillment: null, support: null, recovery: null },
      };
      return Response.json({ ...answer, signature: await seller.signMessage({ message: { raw: canonicalHash(answer) } }) });
    }
    if (url === `${MANAGED_ORIGIN}/standard-rail/assets/action`) {
      const grant = body.grant as SignedEnvelope<ProviderWalletActionGrantV1>;
      const request = body.request as { actionId: string; providerAssetId: string; input: Record<string, unknown> };
      state.grants.push(grant);
      const g = grant.payload;
      const followUp = request.input.operation === "confirm-destructive";
      const executionId = followUp ? request.input.actionExecutionId as Hex : deriveActionExecutionId({
        walletAuthorizationHash: g.walletAuthorizationHash, providerAgentId: BigInt(g.providerAgentId),
        serviceId: g.serviceId, providerControlProfileHash: g.providerControlProfileHash,
        servicingAdmissionHash: g.servicingAdmissionHash, actionCatalogHash: g.actionCatalogHash,
        actionCatalogSchemaHash: g.actionCatalogSchemaHash, actionCatalogEpoch: BigInt(g.actionCatalogEpoch),
        actionDefinitionHash: g.actionDefinitionHash, requestHash: g.requestHash,
      });
      const issuedAt = nowSeconds();
      const common = {
        providerAgentId: MANAGED, payer: g.payer, actionExecutionId: executionId, responseNonce: syntheticHash(`nonce ${issuedAt} ${state.grants.length}`),
        requestHash: g.requestHash, walletAuthorizationHash: g.walletAuthorizationHash,
        grantHash: artifactPayloadHash(grant as unknown as Record<string, unknown> & { signature?: Hex }),
        providerControlProfileHash: g.providerControlProfileHash, servicingAdmissionHash: g.servicingAdmissionHash,
        servicingProfileEpoch: g.servicingProfileEpoch, actionCatalogHash: g.actionCatalogHash,
        actionCatalogSchemaHash: g.actionCatalogSchemaHash, actionCatalogEpoch: g.actionCatalogEpoch,
        actionDefinitionHash: g.actionDefinitionHash,
      };
      const staged = request.actionId === "erase-note" && !followUp;
      let payload: Record<string, unknown>;
      if (staged) {
        // The stage lasts its retention, an hour: long past every date of the manifest.
        const effectSummary = { actionId: request.actionId };
        const stage = { earliestExecutionAt: issuedAt, stageValidBefore: issuedAt + 3_600 };
        const confirmationHash = canonicalHash({
          request, effectSummary, providerControlProfileHash: g.providerControlProfileHash,
          servicingAdmissionHash: g.servicingAdmissionHash, servicingProfileEpoch: g.servicingProfileEpoch,
          actionCatalogHash: g.actionCatalogHash, actionCatalogSchemaHash: g.actionCatalogSchemaHash,
          actionCatalogEpoch: g.actionCatalogEpoch, actionDefinitionHash: g.actionDefinitionHash,
          actionExecutionId: executionId, ...stage,
        });
        payload = { ...common, status: "staged", effectSummary, confirmationHash, ...stage };
      } else {
        payload = { ...common, status: "completed", result: { text: followUp ? "erased" : "a note" }, errorClass: null };
      }
      const lifetime = state.answer.expired ? { issuedAt: issuedAt - 60, validBefore: issuedAt } : { issuedAt, validBefore: issuedAt + 60 };
      return Response.json(await signEnvelope({
        artifactType: staged ? "ProviderAssetActionStageResponseV1" : "ProviderAssetActionResponseV1",
        environment: ENVIRONMENT, chainId: CHAIN_ID, audience: GATEWAY_AUDIENCE, signerKeyId: "provider-wallet",
        account: managedWallet, ...lifetime, payload,
      }));
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  state.fetch = fetchFn as typeof fetch;
  return state;
}

// ---------------------------------------------------------------------------
// The owner's wallet requests.

const ASSET_ID = "4e0f5d3a-2b1c-4d5e-8f60-718293a4b5c6";
async function assetAction(gateway: Gateway, actionId: string, input: Record<string, unknown>,
  beforeSending: () => void = () => undefined) {
  const post = (authorization: unknown) => fetch(`${gateway.url}/wallet/assets/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ payer: payer.address, providerAgentId: MANAGED, actionId, providerAssetId: ASSET_ID, input, authorization }),
  });
  const challenged = await post(null);
  expect(challenged.status).toBe(200);
  const { challenge } = await challenged.json() as { challenge: {
    message: Record<string, unknown> & { providerAgentId: string; actionCatalogEpoch: number; issuedAt: number; validBefore: number };
    signRequest: Parameters<typeof payer.signTypedData>[0];
  } };
  const message = challenge.message;
  const signature = await payer.signTypedData({
    ...challenge.signRequest,
    message: { ...message, providerAgentId: BigInt(message.providerAgentId),
      actionCatalogEpoch: BigInt(message.actionCatalogEpoch), issuedAt: BigInt(message.issuedAt),
      validBefore: BigInt(message.validBefore) },
  } as Parameters<typeof payer.signTypedData>[0]);
  beforeSending();
  const performed = await post({ message, signature });
  return { status: performed.status, body: await performed.json() as Record<string, unknown>, message };
}

// ---------------------------------------------------------------------------

describe("a manifest past every date it carries (postgres)", () => {
  it.each(CLOCKS)("starts, reports ready, admits, dispatches and runs owner actions on %s", async (_label, clock) => {
    const f = await fixture();
    const db = await database(f);
    try {
      setClock(clock);
      expect(clock).toBeGreaterThan(WINDOW.validBefore);
      await seedPaidOrder(db.pool, f.sellerProfile);
      await seedOwnership(db.pool);
      const network = providers();

      // It starts: the start-up check, the rail's epoch chain and the servicing admission all pass.
      const gateway = await startGateway(db.pool, f.manifest, network.fetch);

      // It reports ready, with admission open.
      // The facilitator and the chain are not reached here: their readiness, and the
      // operational figures read from the chain, stand in as healthy.
      vi.spyOn(StandardRailService.prototype, "areDependenciesReady").mockReturnValue(true);
      vi.spyOn(StandardRailService.prototype, "operationalHealth").mockResolvedValue(null as never);
      const health = await fetch(`${gateway.url}/health/ready`);
      const ready = await health.json() as { status: string; dependencies: Record<string, string> };
      expect({ status: health.status, ready: ready.status, admission: ready.dependencies.admission })
        .toEqual({ status: 200, ready: "ready", admission: "ready" });

      // A purchase is admitted: a challenge gets as far as finding the listing, which this database does
      // not have, and a payment as far as reading its payment identifier.
      // A challenge and a payment both pass the admission check, which once closed with CHALLENGE_EXPIRED.
      const answers: Array<{ status: number; code: string }> = [];
      for (const body of [{ request: {} }, { request: {}, paymentPayload: {} }]) {
        const purchase = await fetch(`${gateway.url}/outcomes/${MANAGED}/no-such-outcome/purchase`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        answers.push({ status: purchase.status, code: (await purchase.json() as { error: { code: string } }).error.code });
      }
      expect(answers).toEqual([
        { status: 404, code: "OUTCOME_NOT_FOUND" },
        { status: 400, code: "EXTENSION_REQUIRED_MISSING" },
      ]);

      // A paid order is dispatched to its seller, under the profile signed in 2026.
      await (gateway.service as unknown as { resumePaidOrder(order: StandardOrderRecord): Promise<void> })
        .resumePaidOrder({ orderId: ORDER_ID } as StandardOrderRecord);
      expect(network.dispatches).toHaveLength(1);
      expect(network.dispatches[0]!.dispatch.payload).toMatchObject({
        providerControlProfileHash: canonicalHash(f.sellerProfile), orderId: ORDER_ID,
      });
      expect(network.dispatches[0]!.dispatch.validBefore).toBeGreaterThan(clock);
      const order = await db.pool.query<{ state: string }>("SELECT state FROM standard_orders WHERE order_id=$1", [ORDER_ID]);
      expect(order.rows[0]!.state).toBe("DISPATCHED");

      // The owner runs an action whose admission and definition ended in March 2027.
      const read = await assetAction(gateway, "read-note", {});
      expect(read).toMatchObject({ status: 200, body: { status: "completed", result: { text: "a note" } } });
      // Its grant lasts five minutes from now, not until the admission's date.
      const grant = network.grants.at(-1)!;
      expect(grant.validBefore).toBe(grant.issuedAt + 300);
      expect(grant.issuedAt).toBeGreaterThanOrEqual(clock);

      // A destructive action is staged for its retention and then confirmed.
      const staged = await assetAction(gateway, "erase-note", {});
      expect(staged).toMatchObject({ status: 200, body: { status: "staged" } });
      const stage = staged.body as { actionExecutionId: Hex; confirmationHash: Hex; stageValidBefore: number };
      expect(stage.stageValidBefore).toBeGreaterThan(clock + 3_000);
      const claim = await db.pool.query<{ expires_at: Date; state: string }>(
        "SELECT expires_at,state FROM standard_asset_action_claims WHERE execution_id=$1", [bytes(stage.actionExecutionId)]);
      expect(claim.rows[0]).toEqual({ expires_at: new Date(stage.stageValidBefore * 1_000), state: "staged" });
      const confirmed = await assetAction(gateway, "erase-note", {
        operation: "confirm-destructive", actionExecutionId: stage.actionExecutionId, confirmationHash: stage.confirmationHash,
      });
      expect(confirmed).toMatchObject({ status: 200, body: { status: "completed", result: { text: "erased" } } });

      // Short-lived envelopes still expire: a wallet authorization presented after its five minutes...
      const late = await assetAction(gateway, "read-note", {}, () => vi.setSystemTime((nowSeconds() + 301) * 1_000));
      expect(late.status).not.toBe(200);
      expect(late.body).toMatchObject({ error: { code: "WALLET_AUTHORIZATION_INVALID" } });
      // ...and a provider answer whose own minute has passed.
      network.answer.expired = true;
      const asked = network.grants.length;
      const stale = await assetAction(gateway, "read-note", {});
      expect(network.grants).toHaveLength(asked + 1);
      expect(stale).toMatchObject({ status: 401, body: { error: { code: "WALLET_ACCESS_DENIED" } } });
      // The same answer within its minute is accepted.
      network.answer.expired = false;
      expect(await assetAction(gateway, "read-note", {})).toMatchObject({ status: 200, body: { status: "completed" } });
    } finally {
      for (const gateway of [...running]) await gateway.stop();
      vi.useRealTimers();
      await db.close();
    }
  }, 60_000);

  it("still refuses an equivocating or rolled-back rail epoch on 2032-06-01", async () => {
    const f = await fixture();
    const db = await database(f);
    const clock = CLOCKS[1][1];
    const start = (manifest: StandardRailManifest) => startGateway(db.pool, manifest);
    try {
      setClock(clock);
      await (await start(f.manifest)).stop();

      // Another active rail profile under the same epoch.
      const equivocating = await envelope("ActiveRailProfileV1", {
        ...(f.rail.activeRailProfile.payload as object), activatedAt: WINDOW.issuedAt + 61,
      });
      await expect(start({ ...f.manifest, activeRailProfile: equivocating } as unknown as StandardRailManifest))
        .rejects.toThrow("ACTIVE_RAIL_EPOCH_EQUIVOCATION");
      // Another facilitator profile under the same epoch, bound by a new rail epoch.
      const otherFacilitator = await rail({ railEpoch: "2", prior: f.rail.activeRailProfile, profileId: "long-lived-v1b",
        at: { issuedAt: clock, validBefore: clock + FIVE_YEARS } });
      await expect(start({ ...f.manifest, ...otherFacilitator } as unknown as StandardRailManifest))
        .rejects.toThrow("FACILITATOR_PROFILE_EPOCH_EQUIVOCATION");

      // The next rail epoch, signed now for five years over the same facilitator profile, is admitted.
      const nextRail = await envelope("ActiveRailProfileV1", {
        railEpoch: "2", facilitatorProfileHash: canonicalHash(f.rail.facilitatorProfile), priorRailEpoch: "1",
        priorActiveRailProfileHash: canonicalHash(f.rail.activeRailProfile), environment: ENVIRONMENT, chainId: CHAIN_ID,
        activatedAt: clock, admissionValidBefore: clock + FIVE_YEARS - 2 * DAY, recoveryValidBefore: clock + FIVE_YEARS - DAY,
      }, { issuedAt: clock, validBefore: clock + FIVE_YEARS });
      const advanced = { ...f.manifest, activeRailProfile: nextRail } as unknown as StandardRailManifest;
      await (await start(advanced)).stop();
      // The first epoch cannot come back, however long ago it was signed.
      await expect(start(f.manifest)).rejects.toThrow("ACTIVE_RAIL_EPOCH_ROLLBACK");
      // A rail epoch issued after the clock is refused before anything is read.
      const future = await envelope("ActiveRailProfileV1", { ...(nextRail.payload as object) },
        { issuedAt: clock + 1, validBefore: clock + FIVE_YEARS });
      await expect(start({ ...advanced, activeRailProfile: future } as unknown as StandardRailManifest))
        .rejects.toThrow("ActiveRailProfileV1 artifact is outside its validity window");
    } finally {
      for (const gateway of [...running]) await gateway.stop();
      vi.useRealTimers();
      await db.close();
    }
  }, 60_000);
});
