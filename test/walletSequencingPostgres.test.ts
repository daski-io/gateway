import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPool, runMigrations, type Pool } from "../src/db/pool.js";
import { claimAssetAction } from "../src/standardRail/assetActionClaims.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";
import {
  ContractVerificationSemaphore,
  createPayerSignatureVerifier,
  type PayerSignatureVerifier,
} from "../src/standardRail/payerSignature.js";
import {
  chargeSignatureVerifyAdmission,
  signatureVerifyBucketKey,
} from "../src/standardRail/signatureAdmission.js";
import { StandardWalletStore } from "../src/standardRail/walletStore.js";

/// Spec B2 sequencing for wallet actions: snapshot with a plain SELECT, verify
/// with no lock or connection held, admission charged before any RPC and for
/// failures too, then one short atomic claim; an exact replay of a consumed
/// challenge reuses the admitted identity without re-verification and
/// continues through the execution journal.
const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const CHAIN_ID = 84532;
const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;

const config = {
  encryptionKey: Buffer.alloc(32, 7),
  gatewayAudience: "https://gateway.example",
  environment: "testnet",
  abuse: {
    walletChallengesOutstandingPerClient: 100,
    walletChallengesOutstandingGlobal: 10_000,
    walletChallengesPerClientPerMinute: 1_000,
    walletChallengesGlobalPerMinute: 10_000,
    assetListsPerPayerPerMinute: 1_000,
    protectedReadsPerPayerPerMinute: 1_000,
    assetStateChangesPerPayerPerMinute: 1_000,
  },
} as unknown as StandardRailConfig;

const eoaVerifier: PayerSignatureVerifier = createPayerSignatureVerifier({
  accountTypes: ["eoa"], timeoutMs: 0, endpoints: [],
});

const schema = `wallet_sequencing_${randomUUID().replaceAll("-", "")}`;
let bootstrap: Pool;
let pool: Pool;

beforeAll(async () => {
  bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool({ connectionString: databaseUrl, searchPath: `${schema},public`, max: 10 });
  await runMigrations(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
  await bootstrap.end();
});

async function signedFor(store: StandardWalletStore, action: string, request: unknown, account = signer) {
  const challenge = await store.issue({
    action,
    payer: signer.address,
    request,
    absoluteResourceUri: "https://gateway.example/wallet/resource",
    clientKey: "203.0.113.7",
  });
  const message = challenge.message;
  const signature = await account.signTypedData({
    ...challenge.signRequest,
    message: {
      ...message,
      providerAgentId: BigInt(message.providerAgentId),
      actionCatalogEpoch: BigInt(message.actionCatalogEpoch),
      issuedAt: BigInt(message.issuedAt),
      validBefore: BigInt(message.validBefore),
    },
  });
  return { message, signature };
}

async function nonceRows(): Promise<number> {
  const result = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM standard_wallet_action_nonces");
  return result.rows[0]!.n;
}

describe("wallet action sequencing", () => {
  it("verifies the signature with no transaction or connection held", async () => {
    const active = { count: 0, seenDuringVerify: -1 };
    const trackingPool = {
      query: (text: string, params?: unknown[]) => pool.query(text, params),
      connect: async () => {
        const client = await pool.connect();
        active.count += 1;
        const release = client.release.bind(client);
        client.release = ((...args: unknown[]) => { active.count -= 1; return (release as (...a: unknown[]) => void)(...args); }) as never;
        return client;
      },
    } as unknown as Pool;
    const verifier: PayerSignatureVerifier = {
      accountTypes: ["eoa"],
      verifyPayerTypedData: async () => {
        active.seenDuringVerify = active.count;
        return { accountType: "eoa", verifiedVia: "recovery" };
      },
    };
    const store = new StandardWalletStore(trackingPool, config, CHAIN_ID, verifier);
    const request = { limit: 25, cursor: null };
    const authorization = await signedFor(store, "list-orders", request);
    await expect(store.consume({
      payer: signer.address, authorization: authorization as never, action: "list-orders", request,
    })).resolves.toMatchObject({ payer: signer.address.toLowerCase(), replayed: false });
    expect(active.seenDuringVerify).toBe(0);
    expect(active.count).toBe(0);
  });

  it("charges the signature-verify admission before any RPC, counts failures, and refuses beyond the limit", async () => {
    const calls: string[] = [];
    const client = {
      getCode: async () => { calls.push("getCode"); return "0x" as Hex; },
      call: async () => { calls.push("call"); return { data: "0x" as Hex }; },
    };
    const verifier = createPayerSignatureVerifier({
      accountTypes: ["eoa", "contract"],
      timeoutMs: 1_000,
      endpoints: [{ host: "rpc.example", client }],
      semaphore: new ContractVerificationSemaphore(8),
      admit: async (payer) => {
        calls.push("admit");
        await chargeSignatureVerifyAdmission(pool, payer, 2);
      },
    });
    const store = new StandardWalletStore(pool, config, CHAIN_ID, verifier);
    const request = { limit: 25, cursor: null };
    const nonces: Buffer[] = [];
    // Signed by a key that is not the payer: not an EOA recovery, so the
    // contract path runs and the payer's admission is charged first.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      calls.length = 0;
      const authorization = await signedFor(store, "list-orders", request, stranger);
      nonces.push(Buffer.from(authorization.message.nonce.slice(2), "hex"));
      await expect(store.consume({
        payer: signer.address, authorization: authorization as never, action: "list-orders", request,
      })).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
      expect(calls).toEqual(["admit", "getCode"]);
    }
    const bucket = await pool.query<{ request_count: number }>(
      "SELECT request_count FROM rate_limit_buckets WHERE bucket_key=$1",
      [signatureVerifyBucketKey(signer.address)],
    );
    expect(bucket.rows[0]?.request_count).toBe(2);
    calls.length = 0;
    const authorization = await signedFor(store, "list-orders", request, stranger);
    nonces.push(Buffer.from(authorization.message.nonce.slice(2), "hex"));
    await expect(store.consume({
      payer: signer.address, authorization: authorization as never, action: "list-orders", request,
    })).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_BUSY", retryable: true });
    expect(calls).toEqual(["admit"]);
    // None of the refused attempts consumed its challenge.
    const consumed = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standard_wallet_action_challenges WHERE consumed_at IS NOT NULL AND nonce = ANY($1::bytea[])",
      [nonces],
    );
    expect(consumed.rows[0]!.n).toBe(0);
  });

  it("reuses the admitted identity on an exact replay without re-verification or new admission", async () => {
    const verify = vi.fn(async () => ({ accountType: "eoa" as const, verifiedVia: "recovery" as const }));
    const store = new StandardWalletStore(pool, config, CHAIN_ID, {
      accountTypes: ["eoa"], verifyPayerTypedData: verify,
    });
    const request = { actionId: "renew", providerAssetId: randomUUID(), input: {} };
    const authorization = await signedFor(store, "use-asset:42:renew", request);
    const before = await nonceRows();
    const first = await store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("a"), allowExactReplay: true,
    });
    const second = await store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("a"), allowExactReplay: true,
    });
    expect(first).toMatchObject({ replayed: false, verification: { verifiedVia: "recovery" } });
    expect(second).toMatchObject({
      replayed: true, verification: null, payer: first.payer, authorizationHash: first.authorizationHash,
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await nonceRows()).toBe(before + 1);
  });

  it("refuses an altered replay and a replay where the path allows none", async () => {
    const store = new StandardWalletStore(pool, config, CHAIN_ID, eoaVerifier);
    const request = { actionId: "renew", providerAssetId: randomUUID(), input: {} };
    const authorization = await signedFor(store, "use-asset:42:renew", request);
    await store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("b"), allowExactReplay: true,
    });
    await expect(store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("c"), allowExactReplay: true,
    })).rejects.toThrow("wallet authorization denied");
    await expect(store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("b"),
    })).rejects.toThrow("wallet authorization denied");
    const plain = await signedFor(store, "list-orders", { limit: 25, cursor: null });
    await store.consume({
      payer: signer.address, authorization: plain as never, action: "list-orders", request: { limit: 25, cursor: null },
    });
    await expect(store.consume({
      payer: signer.address, authorization: plain as never, action: "list-orders", request: { limit: 25, cursor: null },
    })).rejects.toThrow("wallet authorization denied");
  });

  it("admits exactly one of a concurrent original and replay; the other continues as a replay", async () => {
    const store = new StandardWalletStore(pool, config, CHAIN_ID, eoaVerifier);
    const request = { actionId: "renew", providerAssetId: randomUUID(), input: {} };
    const authorization = await signedFor(store, "use-asset:42:renew", request);
    const before = await nonceRows();
    const results = await Promise.all([0, 1].map(() => store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("d"), allowExactReplay: true,
    })));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await nonceRows()).toBe(before + 1);
  });

  it("treats a challenge consumed between the snapshot and the claim as an exact replay", async () => {
    const request = { actionId: "renew", providerAssetId: randomUUID(), input: {} };
    const inner = new StandardWalletStore(pool, config, CHAIN_ID, eoaVerifier);
    let authorization!: { message: unknown; signature: Hex };
    let interleaved = 0;
    const outer = new StandardWalletStore(pool, config, CHAIN_ID, {
      accountTypes: ["eoa"],
      verifyPayerTypedData: async () => {
        // The original request lands while this one is verifying.
        if (interleaved === 0) {
          interleaved += 1;
          await inner.consume({
            payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
            request, operationHash: hash("e"), allowExactReplay: true,
          });
        }
        return { accountType: "eoa", verifiedVia: "recovery" };
      },
    });
    authorization = await signedFor(outer, "use-asset:42:renew", request);
    const before = await nonceRows();
    await expect(outer.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("e"), allowExactReplay: true,
    })).resolves.toMatchObject({ replayed: true });
    expect(await nonceRows()).toBe(before + 1);
    // A different operation under the same consumed challenge is refused.
    await expect(outer.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: hash("f"), allowExactReplay: true,
    })).rejects.toThrow("wallet authorization denied");
  });

  it("continues through the execution journal after a crash between consumption and the claim", async () => {
    const store = new StandardWalletStore(pool, config, CHAIN_ID, eoaVerifier);
    const request = { actionId: "renew", providerAssetId: randomUUID(), input: {} };
    const authorization = await signedFor(store, "use-asset:42:renew", request);
    const executionId = hash("9");
    const admitted = await store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: executionId, allowExactReplay: true,
    });
    // Crash here: the challenge is consumed, nothing else happened.
    const replay = await store.consume({
      payer: signer.address, authorization: authorization as never, action: "use-asset:42:renew",
      request, operationHash: executionId, allowExactReplay: true,
    });
    expect(replay).toMatchObject({ replayed: true, payer: admitted.payer });
    const claim = {
      executionId,
      payer: admitted.payer,
      providerAgentId: "42",
      serviceId: hash("2"),
      operation: "use" as const,
      stagedExecutionId: null,
      walletAuthorizationHash: admitted.authorizationHash,
      requestHash: hash("4"),
      providerControlProfileHash: hash("5"),
      servicingAdmissionHash: hash("6"),
      actionCatalogHash: hash("7"),
      actionCatalogSchemaHash: hash("8"),
      actionCatalogEpoch: 1,
      actionDefinitionHash: hash("3"),
      stageValidBefore: null,
    };
    await claimAssetAction(pool, claim);
    // A lost provider response: the same claim is idempotent, so one execution
    // continues instead of a second one starting.
    await expect(claimAssetAction(pool, claim)).resolves.toBeUndefined();
    await expect(claimAssetAction(pool, { ...claim, requestHash: hash("1") }))
      .rejects.toThrow("asset action claim mismatch");
    const claims = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM standard_asset_action_claims WHERE execution_id=$1",
      [Buffer.from(executionId.slice(2), "hex")],
    );
    expect(claims.rows[0]!.n).toBe(1);
  });
});
