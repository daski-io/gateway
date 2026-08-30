import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createPool, type Pool } from "../src/db/pool.js";
import { StandardAssetFederation } from "../src/standardRail/assetFederation.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import { StandardWalletQueries } from "../src/standardRail/walletQueries.js";
import { StandardWalletStore } from "../src/standardRail/walletStore.js";
import type { WalletActionAuthorizationV1 } from "../src/standardRail/types.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";

/** The wallet that legitimately signs. */
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
/** A wallet the signer holds no key for. */
const OTHER = "0xBBbBbBBbBBbbBBbBBBBbbBbbBbbBbbbBBbBBbBbB";

const walletActionTypes = {
  WalletActionAuthorizationV1: [
    { name: "payer", type: "address" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "providerControlProfileHash", type: "bytes32" },
    { name: "servicingAdmissionHash", type: "bytes32" },
    { name: "actionCatalogHash", type: "bytes32" },
    { name: "actionCatalogSchemaHash", type: "bytes32" },
    { name: "actionDefinitionHash", type: "bytes32" },
    { name: "actionCatalogEpoch", type: "uint64" },
    { name: "actionHash", type: "bytes32" },
    { name: "methodHash", type: "bytes32" },
    { name: "absoluteResourceUriHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

const config = {
  encryptionKey: Buffer.alloc(32, 7),
  gatewayAudience: "https://gateway.example",
  environment: "testnet",
  cursorKeyRing: [{ id: 1, key: Buffer.alloc(32, 9) }],
  evidenceRpcUrls: ["https://rpc.example"],
  reputationContract: "0x1111111111111111111111111111111111111111",
  dispatchTimeoutMs: 5_000,
  manifest: { servicingAdmissions: [], actionCatalogs: [] },
  abuse: {
    walletChallengesOutstandingPerClient: 100,
    walletChallengesOutstandingGlobal: 1_000,
    assetListsPerPayerPerMinute: 100,
    protectedReadsPerPayerPerMinute: 100,
    assetStateChangesPerPayerPerMinute: 100,
    federationMaxProviders: 10,
    federationPerProviderConcurrency: 2,
    federationGlobalConcurrency: 4,
  },
} as unknown as StandardRailConfig;

const schema = `wallet_cross_payer_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;
let store: StandardWalletStore;

/** Issue a challenge for `signer`, then sign it exactly as an honest client would. */
async function signedFor(action: string, request: unknown) {
  const challenge = await store.issue({
    action,
    payer: signer.address,
    request,
    absoluteResourceUri: "https://gateway.example/wallet/resource",
    clientKey: "203.0.113.7",
  });
  const message = challenge.message as WalletActionAuthorizationV1;
  const signature = await signer.signTypedData({
    domain: { name: "DaskiStandardWallet", version: "1", chainId: baseSepolia.id },
    primaryType: "WalletActionAuthorizationV1",
    types: walletActionTypes,
    message: {
      ...message,
      providerAgentId: BigInt(message.providerAgentId),
      actionCatalogEpoch: BigInt(message.actionCatalogEpoch),
      issuedAt: BigInt(message.issuedAt),
      validBefore: BigInt(message.validBefore),
    },
  });
  return { message, signature } as never;
}

function queries(spy?: (params: unknown[]) => void) {
  const spyPool = {
    query: async (text: string, params: unknown[]) => {
      if (text.includes("standard_orders")) { spy?.(params); return { rows: [], rowCount: 0 }; }
      return pool.query(text as never, params as never);
    },
    connect: () => pool.connect(),
  } as unknown as Pool;
  const instance = new StandardWalletQueries(spyPool, store, config, baseSepolia);
  Object.assign(instance as unknown as { clients: unknown[] }, {
    clients: [{
      host: "rpc.example",
      client: {
        getBlock: async () => ({ number: 1n }),
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === "getBuyerStats" ? [0n, 0n, 0n] : 0n,
      },
    }],
  });
  return instance;
}

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: schema, max: 4 });
  await pool.query(`
    CREATE TABLE standard_wallet_action_challenges (
      nonce BYTEA PRIMARY KEY,
      client_key_hash BYTEA NOT NULL,
      payer TEXT NOT NULL,
      action_hash BYTEA NOT NULL,
      request_hash BYTEA NOT NULL,
      canonical_authorization JSONB NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      valid_before TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ);
    CREATE TABLE standard_wallet_action_nonces (
      payer TEXT NOT NULL,
      nonce BYTEA NOT NULL,
      authorization_hash BYTEA NOT NULL,
      operation_hash BYTEA NOT NULL,
      consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (payer, nonce));
    CREATE TABLE standard_action_challenges (
      nonce BYTEA PRIMARY KEY, client_key_hash BYTEA,
      valid_before TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ);
    CREATE TABLE rate_limit_buckets (
      bucket_key TEXT PRIMARY KEY,
      window_started_at TIMESTAMPTZ NOT NULL,
      request_count INTEGER NOT NULL CHECK (request_count > 0));
  `);
  store = new StandardWalletStore(pool, config, baseSepolia.id);
});

afterAll(async () => {
  await pool?.end();
  await bootstrap?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await bootstrap?.end();
});

describe("wallet authorization is bound to the operation payer", () => {
  it("denies a signed challenge replayed against another payer", async () => {
    const request = { limit: 25, cursor: null };
    await expect(store.consume({
      payer: OTHER,
      authorization: await signedFor("list-orders", request),
      action: "list-orders",
      request,
    })).rejects.toThrow("wallet authorization denied");
  });

  it("returns the verified payer when the operation targets the signer", async () => {
    const request = { limit: 25, cursor: null };
    await expect(store.consume({
      payer: signer.address,
      authorization: await signedFor("list-orders", request),
      action: "list-orders",
      request,
    })).resolves.toMatchObject({ payer: signer.address.toLowerCase() });
  });

  it("denies cross-payer order history reads", async () => {
    const seen: unknown[][] = [];
    await expect(queries((params) => seen.push(params)).listOrders({
      payer: OTHER,
      limit: 25,
      cursor: null,
      authorization: await signedFor("list-orders", { limit: 25, cursor: null }),
    })).rejects.toThrow("wallet authorization denied");
    expect(seen).toHaveLength(0);
  });

  it("queries only the verified payer on the honest order-history path", async () => {
    const seen: unknown[][] = [];
    await queries((params) => seen.push(params)).listOrders({
      payer: signer.address,
      limit: 25,
      cursor: null,
      authorization: await signedFor("list-orders", { limit: 25, cursor: null }),
    });
    expect(seen[0]?.[0]).toBe(signer.address.toLowerCase());
  });

  it("denies cross-payer reputation reads", async () => {
    await expect(queries().getReputation({
      payer: OTHER,
      authorization: await signedFor("get-buyer-reputation", {}),
    })).rejects.toThrow("wallet authorization denied");
  });

  it("denies cross-payer asset federation", async () => {
    const seen: unknown[][] = [];
    const spyPool = {
      query: async (text: string, params: unknown[]) => {
        if (text.includes("standard_orders")) { seen.push(params); return { rows: [], rowCount: 0 }; }
        return pool.query(text as never, params as never);
      },
      connect: () => pool.connect(),
    } as unknown as Pool;
    const federation = new StandardAssetFederation(
      spyPool, config, baseSepolia.id, store,
      async () => new Response(null, { status: 503 }),
    );
    const request = { providerAgentId: null, limit: 25, cursor: null };
    await expect(federation.listAssets({
      payer: OTHER,
      providerAgentId: null,
      limit: 25,
      cursor: null,
      authorization: await signedFor("list-assets", request),
    })).rejects.toThrow("wallet authorization denied");
    expect(seen).toHaveLength(0);
  });
});
