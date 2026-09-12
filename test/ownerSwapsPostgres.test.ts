import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { Config } from "../src/config.js";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import type { MarketplaceChainReader } from "../src/marketplace/reader.js";
import {
  OwnerSwapService,
  ownerSwapContentHash,
  parseOwnerSwapPayload,
  type ProviderOwnerSwapV1,
} from "../src/serviceRegistration/ownerSwaps.js";
import { createServiceRegistrationRouter } from "../src/serviceRegistration/routes.js";
import {
  eligibleProvidersForPayer,
  isPayerEligibleForProvider,
} from "../src/standardRail/assetEligibility.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import { artifactPayloadHash } from "../src/standardRail/canonical.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import { StandardWalletStore } from "../src/standardRail/walletStore.js";

/// Spec C1: the provider-signed owner swap route, its idempotency by asset
/// and version, its fail-closed checks, the eligibility union, and the proof
/// that a swap alters no order, claim, nonce, receipt, or reputation row.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const authorityKey = `0x${"11".repeat(32)}` as Hex;
const rotatedKey = `0x${"22".repeat(32)}` as Hex;
const strangerKey = `0x${"33".repeat(32)}` as Hex;
const authority = privateKeyToAccount(authorityKey);
const rotated = privateKeyToAccount(rotatedKey);
const newOwner = privateKeyToAccount(`0x${"44".repeat(32)}`);
const PUBLIC_URL = "https://gateway.example";
const PROVIDER = "42";
const OTHER_PROVIDER = "7";
const previousPayer = "0x1111111111111111111111111111111111111111" as Hex;
const newPayer = newOwner.address.toLowerCase() as Hex;
const orderId = "ord_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherProviderOrderId = "ord_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mismatchedKeyOrderId = "ord_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const assetId = "5e0f95a6-3f9f-4bb0-9a68-59f2e26bde33";

const schema = `owner_swaps_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;
let server: Server;
let root: string;
const identity = { owner: authority.address as Address, agentWallet: getAddress(`0x${"55".repeat(20)}`) };
const providerActive = { value: true };
const screen = vi.fn(async (_payer: Address) => undefined);
const railConfig = {
  environment: "testnet",
  ownerSwaps: { enabled: true, perProviderPerDay: 3 },
} as unknown as StandardRailConfig;
const config = {
  chainId: 84532, publicUrl: PUBLIC_URL, dynamicServiceRegistrationEnabled: true,
  catalogOperatorToken: "catalog-operator-token-for-tests-0123456789",
} as Config;
const marketplace = {
  addresses: {} as MarketplaceChainReader["addresses"],
  resolveWallet: async () => ({ agentId: PROVIDER, found: true }),
  listProviders: async () => ({}),
  getService: async () => { throw new Error("not used"); },
  getProvider: async (agentId: bigint) => ({
    agentId: agentId.toString(), active: providerActive.value, identity: { ...identity },
  }),
} as MarketplaceChainReader;

function payload(overrides: Partial<ProviderOwnerSwapV1> = {}): ProviderOwnerSwapV1 {
  return {
    providerAgentId: PROVIDER,
    providerAssetId: assetId,
    ownerVersion: 1,
    orderId,
    orderKey: keccak256(toBytes(orderId)),
    previousPayer,
    newPayer,
    ...overrides,
  };
}

async function envelope(
  value: ProviderOwnerSwapV1,
  options: { privateKey?: Hex; audience?: string; environment?: string; chainId?: number; issuedAt?: number } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
  const issuedAt = options.issuedAt ?? now - 1;
  return signEnvelope({
    artifactType: "ProviderOwnerSwapV1",
    environment: options.environment ?? "testnet",
    chainId: options.chainId ?? 84532,
    audience: options.audience ?? PUBLIC_URL,
    signerKeyId: "provider-authority",
    privateKey: options.privateKey ?? authorityKey,
    issuedAt,
    validBefore: issuedAt + 300,
    payload: value,
  });
}

async function post(body: unknown, headers: Record<string, string> = { "idempotency-key": `own-${assetId}-1` }) {
  const response = await fetch(`${root}/v1/owner-swaps`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function insertOrder(id: string, provider: string, key: Hex, payer: string | null) {
  await pool.query(
    `INSERT INTO standard_orders (
       order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
       listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,
       canonical_request_hash,canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,
       listing_epoch,expires_at,payer)
     VALUES ($1,$2,$3,$4,'FULFILLED',$5,'register-domain','recipe-bound-v2',$6,$6,'{}',$6,'{}',
       $6,'{}',$7,$8,5000000,1,1,now()+interval '1 day',$9)`,
    [id, Buffer.from(key.slice(2), "hex"), `handle-${id}`, Buffer.from(keccak256(toBytes(`h-${id}`)).slice(2), "hex"),
      provider, Buffer.alloc(32, 2), Buffer.from(keccak256(toBytes(`n-${id}`)).slice(2), "hex"),
      `int_${id.slice(4)}`, payer],
  );
}

async function rowDigests(): Promise<Record<string, string[]>> {
  const tables = [
    "standard_orders", "standard_asset_action_claims", "standard_wallet_action_nonces",
    "standard_action_nonces", "standard_rail_receipts", "standard_reputation_operations",
    "standard_reputation_confirmations",
  ];
  const digests: Record<string, string[]> = {};
  for (const table of tables) {
    const result = await pool.query<{ digest: string }>(`SELECT md5(t::text) AS digest FROM ${table} t ORDER BY 1`);
    digests[table] = result.rows.map((row) => row.digest);
  }
  return digests;
}

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 6 });
  await runMigrations(pool);
  await insertOrder(orderId, PROVIDER, keccak256(toBytes(orderId)), previousPayer);
  await insertOrder(otherProviderOrderId, OTHER_PROVIDER, keccak256(toBytes(otherProviderOrderId)), previousPayer);
  await insertOrder(mismatchedKeyOrderId, PROVIDER, `0x${"dd".repeat(32)}`, previousPayer);
  const app = express();
  app.use(express.json());
  app.use(createServiceRegistrationRouter({
    config,
    service: {} as never,
    ownerSwaps: new OwnerSwapService({ config, railConfig, pool, marketplace, screen }),
  }));
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("listener unavailable");
  root = `http://127.0.0.1:${bound.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

describe("POST /v1/owner-swaps", () => {
  it("records a fresh provider-signed swap once and replays it by asset and version", async () => {
    const before = await rowDigests();
    const swap = payload();
    const first = await post(await envelope(swap));
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      providerAssetId: assetId,
      ownerVersion: 1,
      newPayer,
      contentHash: ownerSwapContentHash(swap),
      receivedAt: expect.any(String),
    });
    // Equal content hash: the persisted record, regardless of envelope age or key.
    const replayed = await post(await envelope(swap));
    expect(replayed).toEqual({ status: 200, body: first.body });
    const expired = await post(await envelope(swap, { issuedAt: Math.floor(Date.now() / 1_000) - 7_200 }));
    expect(expired).toEqual({ status: 200, body: first.body });
    const rotatedReplay = await post(await envelope(swap, { privateKey: rotatedKey }));
    expect(rotatedReplay).toEqual({ status: 200, body: first.body });
    // A different payload under the same key is a conflict.
    const conflict = await post(await envelope(payload({ newPayer: `0x${"66".repeat(20)}` })));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "OWNER_SWAP_CONFLICT" } });
    // Nothing else changed.
    const after = await rowDigests();
    expect(after).toEqual(before);
    const rows = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM standard_provider_owner_swaps");
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("grants the new payer eligibility with the signing provider only", async () => {
    expect(await isPayerEligibleForProvider(pool, newPayer, PROVIDER)).toBe(true);
    expect(await isPayerEligibleForProvider(pool, newPayer, OTHER_PROVIDER)).toBe(false);
    expect(await isPayerEligibleForProvider(pool, previousPayer, PROVIDER)).toBe(true);
    expect(await eligibleProvidersForPayer(pool, newPayer, null, 10)).toEqual([PROVIDER]);
    expect(await eligibleProvidersForPayer(pool, newPayer, OTHER_PROVIDER, 10)).toEqual([]);
    // The federation site uses the same union: the swapped provider is queried.
    const walletConfig = {
      ...railConfig,
      encryptionKey: Buffer.alloc(32, 7),
      gatewayAudience: PUBLIC_URL,
      dispatchTimeoutMs: 5_000,
      manifest: { servicingAdmissions: [], actionCatalogs: [], providerControlProfiles: [] },
      abuse: {
        walletChallengesOutstandingPerClient: 100, walletChallengesOutstandingGlobal: 1_000,
        assetListsPerPayerPerMinute: 100, protectedReadsPerPayerPerMinute: 100,
        assetStateChangesPerPayerPerMinute: 100, federationMaxProviders: 10,
        federationPerProviderConcurrency: 2, federationGlobalConcurrency: 4,
        federationPerProviderPerMinute: 100, federationGlobalPerMinute: 100,
      },
    } as unknown as StandardRailConfig;
    const store = new StandardWalletStore(pool, walletConfig, baseSepolia.id);
    const federation = new StandardAssetFederation(
      pool, walletConfig, baseSepolia.id, store, async () => new Response(null, { status: 503 }),
    );
    const request = { providerAgentId: null, limit: 25, cursor: null };
    const challenge = await store.issue({
      action: "list-assets", payer: newOwner.address, request,
      absoluteResourceUri: `${PUBLIC_URL}/wallet/assets`, clientKey: "203.0.113.7",
    });
    const signature = await newOwner.signTypedData({
      ...challenge.signRequest,
      message: {
        ...challenge.message,
        providerAgentId: BigInt(challenge.message.providerAgentId),
        actionCatalogEpoch: BigInt(challenge.message.actionCatalogEpoch),
        issuedAt: BigInt(challenge.message.issuedAt),
        validBefore: BigInt(challenge.message.validBefore),
      },
    });
    const listed = await federation.listAssets({
      payer: newOwner.address, providerAgentId: null, limit: 25, cursor: null,
      authorization: { message: challenge.message, signature } as never,
    });
    expect(listed.providers.map((item) => item.providerAgentId)).toEqual([PROVIDER]);
  });

  it("requires a fresh envelope from the live provider authority on first acceptance", async () => {
    const stale = payload({ ownerVersion: 2 });
    const expired = await post(await envelope(stale, { issuedAt: Math.floor(Date.now() / 1_000) - 7_200 }), { "idempotency-key": "idem-own-v2-expired-0001" });
    expect(expired.status).toBe(401);
    const rotatedFirst = await post(await envelope(stale, { privateKey: rotatedKey }), { "idempotency-key": "idem-own-v2-rotated-0001" });
    expect(rotatedFirst.status).toBe(401);
    const stranger = await post(await envelope(stale, { privateKey: strangerKey }), { "idempotency-key": "idem-own-v2-bad-0001" });
    expect(stranger.status).toBe(401);
    for (const domain of [
      { audience: "https://other-gateway.example" },
      { environment: "mainnet" },
      { chainId: 8453 },
    ]) {
      const refused = await post(await envelope(stale, domain), { "idempotency-key": "idem-own-v2-domain-0001" });
      expect(refused.status).toBe(401);
      expect(refused.body).toMatchObject({ error: { code: "OWNER_SWAP_AUTH_INVALID" } });
    }
    // After the provider rotates its authority, the rotated key is the live one.
    identity.owner = rotated.address;
    const accepted = await post(await envelope(stale, { privateKey: rotatedKey }), { "idempotency-key": "idem-own-v2-0001" });
    expect(accepted.status).toBe(201);
    identity.owner = authority.address;
    // Replay under the old key still answers the persisted record.
    const oldKeyReplay = await post(await envelope(stale), { "idempotency-key": "idem-own-v2-0001" });
    expect(oldKeyReplay.status).toBe(200);
  });

  it("fails closed on the order binding, the payload format, and the idempotency header", async () => {
    const wrongProvider = await post(await envelope(payload({
      ownerVersion: 3, orderId: otherProviderOrderId, orderKey: keccak256(toBytes(otherProviderOrderId)),
    })), { "idempotency-key": "idem-own-v3-0001" });
    expect(wrongProvider.status).toBe(409);
    expect(wrongProvider.body).toMatchObject({ error: { code: "ORDER_PROVIDER_MISMATCH" } });
    const wrongKey = await post(await envelope(payload({
      ownerVersion: 3, orderId: mismatchedKeyOrderId, orderKey: keccak256(toBytes(mismatchedKeyOrderId)),
    })), { "idempotency-key": "idem-own-v3-0001" });
    expect(wrongKey.status).toBe(409);
    expect(wrongKey.body).toMatchObject({ error: { code: "ORDER_KEY_MISMATCH" } });
    const missingOrder = await post(await envelope(payload({
      ownerVersion: 3, orderId: "ord_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      orderKey: keccak256(toBytes("ord_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")),
    })), { "idempotency-key": "idem-own-v3-0001" });
    expect(missingOrder.status).toBe(404);
    const badKey = await post(await envelope({ ...payload({ ownerVersion: 3 }), orderKey: `0x${"ab".repeat(32)}` }), { "idempotency-key": "idem-own-v3-0001" });
    expect(badKey.status).toBe(400);
    expect(badKey.body).toMatchObject({ error: { code: "OWNER_SWAP_INVALID" } });
    const samePayer = await post(await envelope(payload({ ownerVersion: 3, newPayer: previousPayer })), { "idempotency-key": "idem-own-v3-0001" });
    expect(samePayer.status).toBe(400);
    const extraField = await post({ ...(await envelope(payload({ ownerVersion: 3 }))), extra: 1 }, { "idempotency-key": "idem-own-v3-0001" });
    expect(extraField.status).toBe(401);
    const noHeader = await post(await envelope(payload({ ownerVersion: 3 })), {});
    expect(noHeader.status).toBe(400);
    expect(noHeader.body).toMatchObject({ error: { code: "INVALID_IDEMPOTENCY_KEY" } });
    expect(() => parseOwnerSwapPayload({ ...payload(), ownerVersion: 0 })).toThrow(/ownerVersion/);
    expect(() => parseOwnerSwapPayload({ ...payload(), providerAssetId: "not-a-uuid" })).toThrow(/providerAssetId/);
  });

  it("screens the new payer through the sanctions oracle and fails closed when it is unavailable", async () => {
    screen.mockRejectedValueOnce(new Error("SANCTIONS_ADDRESS_REJECTED"));
    const sanctioned = await post(await envelope(payload({ ownerVersion: 3 })), { "idempotency-key": "idem-own-v3-0001" });
    expect(sanctioned.status).toBe(403);
    expect(sanctioned.body).toMatchObject({ error: { code: "NEW_PAYER_SANCTIONED" } });
    screen.mockRejectedValueOnce(new Error("rpc unavailable"));
    const unavailable = await post(await envelope(payload({ ownerVersion: 3 })), { "idempotency-key": "idem-own-v3-0001" });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: { code: "SCREENING_UNAVAILABLE" } });
    expect(screen).toHaveBeenLastCalledWith(getAddress(newPayer));
    const rows = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standard_provider_owner_swaps WHERE owner_version=3",
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("caps first acceptances per provider per day and never counts replays", async () => {
    // Versions 1 and 2 were accepted above; the cap is three.
    const third = await post(await envelope(payload({ ownerVersion: 3 })), { "idempotency-key": "idem-own-v3-0001" });
    expect(third.status).toBe(201);
    const fourth = await post(await envelope(payload({ ownerVersion: 4 })), { "idempotency-key": "idem-own-v4-0001" });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ error: { code: "OWNER_SWAP_RATE_LIMITED" } });
    const replay = await post(await envelope(payload({ ownerVersion: 3 })), { "idempotency-key": "idem-own-v3-0001" });
    expect(replay.status).toBe(200);
    // Another provider has its own budget.
    const other = await post(await envelope(payload({
      providerAgentId: OTHER_PROVIDER, ownerVersion: 1, orderId: otherProviderOrderId,
      orderKey: keccak256(toBytes(otherProviderOrderId)),
    })), { "idempotency-key": "idem-own-other-1-0001" });
    expect(other.status).toBe(201);
  });

  it("is refused entirely while OWNER_SWAPS_ENABLED is off", async () => {
    const disabled = new OwnerSwapService({
      config, railConfig: { ...railConfig, ownerSwaps: { enabled: false, perProviderPerDay: 50 } } as never,
      pool, marketplace, screen,
    });
    await expect(disabled.submit(await envelope(payload({ ownerVersion: 9 }))))
      .rejects.toMatchObject({ status: 403, code: "OWNER_SWAPS_DISABLED" });
  });

  it("pins the artifact payload hash the provider signs", async () => {
    const signed = await envelope(payload());
    expect(artifactPayloadHash(signed as unknown as Record<string, unknown>)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ownerSwapContentHash(payload())).toBe(ownerSwapContentHash({ ...payload() }));
    expect(ownerSwapContentHash(payload())).not.toBe(ownerSwapContentHash(payload({ ownerVersion: 2 })));
  });
});
