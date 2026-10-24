import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTransaction,
  recoverMessageAddress,
  recoverTypedDataAddress,
  toFunctionSelector,
  type Hex,
  type TransactionSerializable,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/standardRail/canonical.js";
import { signEnvelope } from "../src/standardRail/signing.js";
import {
  loadGatewaySigners,
  probeSigners,
  signerStatuses,
  signersHealthy,
  SignerRefused,
  SignerUnavailable,
  verifySigners,
} from "../src/standardRail/signer.js";
import { logger } from "../src/util/logger.js";

const identityKey = `0x${"41".repeat(32)}` as Hex;
const senderKey = `0x${"42".repeat(32)}` as Hex;
const identity = privateKeyToAccount(identityKey);
const sender = privateKeyToAccount(senderKey);

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}
const identitySigner = p256();
const senderSigner = p256();

afterEach(() => { vi.restoreAllMocks(); });

describe("local signers", () => {
  it("use FACILITATOR_PRIVATE_KEY for both roles by default, exactly as before", () => {
    const signers = loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey });
    expect(signers.backend).toBe("local");
    expect(signers.identity.address).toBe(identity.address);
    expect(signers.sender.address).toBe(identity.address);
    expect(signers.prerequisites).toEqual(["FACILITATOR_PRIVATE_KEY"]);
    expect(signersHealthy(signers)).toBe(true);
    expect(signerStatuses(signers)).toEqual([
      { role: "identity", backend: "local", address: identity.address, status: "healthy", refusals: 0 },
      { role: "sender", backend: "local", address: identity.address, status: "healthy", refusals: 0 },
    ]);
  });

  it("take an optional sender key and check configured addresses", () => {
    const signers = loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey, GATEWAY_SENDER_PRIVATE_KEY: senderKey,
      PRIVY_IDENTITY_ADDRESS: identity.address, PRIVY_SENDER_ADDRESS: sender.address });
    expect(signers.sender.address).toBe(sender.address);
    expect(signers.prerequisites).toEqual(["FACILITATOR_PRIVATE_KEY", "GATEWAY_SENDER_PRIVATE_KEY"]);
    expect(() => loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey, PRIVY_IDENTITY_ADDRESS: sender.address }))
      .toThrow("PRIVY_IDENTITY_ADDRESS does not match the identity key");
    expect(() => loadGatewaySigners({})).toThrow("FACILITATOR_PRIVATE_KEY must be a non-zero 32-byte private key");
    expect(() => loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey, SIGNER_BACKEND: "kms" }))
      .toThrow("SIGNER_BACKEND must be local or privy");
  });

  it("sign messages only as raw bytes and never sign a bare hash", async () => {
    const { identity: signer } = loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey });
    const raw = `0x${"ab".repeat(32)}` as Hex;
    const signature = await signer.account.signMessage({ message: { raw } });
    expect(await recoverMessageAddress({ message: { raw }, signature })).toBe(identity.address);
    await expect(signer.account.signMessage({ message: raw })).rejects.toBeInstanceOf(SignerRefused);
    await expect(signer.account.sign!({ hash: raw })).rejects.toThrow("RAW_HASH_SIGNING_FORBIDDEN");
  });
});

interface Call { method: string; url: string; body: Record<string, unknown> | null; headers: Headers }

/** Privy's wallet API at the HTTP level, signing with ordinary local keys. */
function privyApi(options: {
  respond?: (call: Call) => Response | null | Promise<Response | null>;
  wallets?: Record<string, { address: string; signers: Array<{ signer_id: string; override_policy_ids?: string[] }> }>;
  quorums?: Record<string, string[]>;
} = {}) {
  const keys: Record<string, Hex> = { "wallet-identity": identityKey, "wallet-sender": senderKey };
  const wallets = options.wallets ?? {
    "wallet-identity": { address: identity.address, signers: [{ signer_id: "quorum-identity", override_policy_ids: ["policy-identity"] }] },
    "wallet-sender": { address: sender.address, signers: [{ signer_id: "quorum-sender", override_policy_ids: ["policy-sender"] }] },
  };
  const quorums = options.quorums ?? { "quorum-identity": [identitySigner.publicKey], "quorum-sender": [senderSigner.publicKey] };
  const calls: Call[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const call: Call = { method: init?.method ?? "GET", url: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, headers: new Headers(init?.headers) };
    calls.push(call);
    // Like fetch, an aborted request (the client's timeout) rejects.
    const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener("abort",
      () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true }));
    const custom = await Promise.race([Promise.resolve(options.respond?.(call) ?? null), aborted]);
    if (custom) return custom;
    const wallet = /^\/v1\/wallets\/([^/]+)$/.exec(url.pathname);
    if (wallet && call.method === "GET") {
      const found = wallets[wallet[1]!];
      return found ? json({ id: wallet[1], address: found.address, additional_signers: found.signers, chain_type: "ethereum",
        created_at: 0, exported_at: null, imported_at: null, owner_id: "owner-quorum", policy_ids: [] }) : json({ error: "not found" }, 404);
    }
    const quorum = /^\/v1\/key_quorums\/([^/]+)$/.exec(url.pathname);
    if (quorum) {
      const found = quorums[quorum[1]!];
      return found ? json({ id: quorum[1], authorization_keys: found.map((public_key) => ({ public_key, display_name: null })),
        authorization_threshold: 1, display_name: null, user_ids: null }) : json({ error: "not found" }, 404);
    }
    const rpc = /^\/v1\/wallets\/([^/]+)\/rpc$/.exec(url.pathname);
    if (rpc && call.body) {
      const account = privateKeyToAccount(keys[rpc[1]!]!);
      const params = call.body.params as Record<string, unknown>;
      if (call.body.method === "personal_sign") {
        expect(params.encoding).toBe("hex");
        const signature = await account.signMessage({ message: { raw: `0x${params.message as string}` } });
        return json({ method: "personal_sign", data: { signature, encoding: "hex" } });
      }
      if (call.body.method === "eth_signTypedData_v4") {
        const typed = params.typed_data as { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown>; primary_type: string };
        const signature = await account.signTypedData({ domain: typed.domain, types: typed.types as never,
          primaryType: typed.primary_type, message: typed.message } as never);
        return json({ method: "eth_signTypedData_v4", data: { signature, encoding: "hex" } });
      }
      if (call.body.method === "eth_signTransaction") {
        // Privy signs exactly what arrives, filling nothing.
        const tx = params.transaction as Record<string, string | number | undefined>;
        const big = (value: string | number | undefined) => value === undefined ? undefined : BigInt(value);
        const signed = await account.signTransaction({
          type: "eip1559", chainId: Number(tx.chain_id), nonce: tx.nonce === undefined ? 0 : Number(tx.nonce),
          to: tx.to as Hex, data: tx.data as Hex | undefined, value: big(tx.value) ?? 0n, gas: big(tx.gas_limit),
          maxFeePerGas: big(tx.max_fee_per_gas), maxPriorityFeePerGas: big(tx.max_priority_fee_per_gas),
        } as TransactionSerializable);
        return json({ method: "eth_signTransaction", data: { signed_transaction: signed, encoding: "rlp" } });
      }
    }
    return json({ error: "unexpected request" }, 400);
  });
  return { fetch, calls };
}

function privyEnv(extra: Record<string, string> = {}) {
  return {
    SIGNER_BACKEND: "privy", PRIVY_APP_ID: "app-test", PRIVY_APP_SECRET: "privy-app-secret-for-tests",
    PRIVY_IDENTITY_WALLET_ID: "wallet-identity", PRIVY_IDENTITY_ADDRESS: identity.address,
    PRIVY_IDENTITY_AUTHORIZATION_PRIVATE_KEY: `wallet-auth:${identitySigner.privateKey}`,
    PRIVY_SENDER_WALLET_ID: "wallet-sender", PRIVY_SENDER_ADDRESS: sender.address,
    PRIVY_SENDER_AUTHORIZATION_PRIVATE_KEY: senderSigner.privateKey,
    SIGNER_TIMEOUT_MS: "300",
    ...extra,
  };
}

const transaction = (overrides: Partial<TransactionSerializable> = {}): TransactionSerializable => ({
  type: "eip1559", chainId: 84532, nonce: 0, to: `0x${"77".repeat(20)}`, data: "0x12345678", value: 0n,
  gas: 150_000n, maxFeePerGas: 3_000_000_000n, maxPriorityFeePerGas: 1_000_000n, ...overrides,
} as TransactionSerializable);

describe("Privy signers", () => {
  it("validate their configuration and let the sender share the identity's wallet", () => {
    const { fetch } = privyApi();
    expect(() => loadGatewaySigners(privyEnv({ PRIVY_APP_ID: "" }), { fetch })).toThrow("PRIVY_APP_ID is required");
    expect(() => loadGatewaySigners(privyEnv({ PRIVY_APP_SECRET: "" }), { fetch })).toThrow("PRIVY_APP_SECRET is required");
    expect(() => loadGatewaySigners(privyEnv({ SIGNER_TIMEOUT_MS: "5001" }), { fetch })).toThrow("SIGNER_TIMEOUT_MS");
    expect(() => loadGatewaySigners(privyEnv({ PRIVY_IDENTITY_AUTHORIZATION_PRIVATE_KEY: "not-a-key" }), { fetch }))
      .toThrow("PRIVY_IDENTITY_AUTHORIZATION_PRIVATE_KEY must be a base64 PKCS8 P-256 private key");
    expect(() => loadGatewaySigners(privyEnv({ PRIVY_SENDER_WALLET_ID: "" }), { fetch }))
      .toThrow("PRIVY_SENDER_WALLET_ID, PRIVY_SENDER_ADDRESS, PRIVY_SENDER_AUTHORIZATION_PRIVATE_KEY must all be set");
    const shared = loadGatewaySigners(privyEnv({ PRIVY_SENDER_WALLET_ID: "", PRIVY_SENDER_ADDRESS: "",
      PRIVY_SENDER_AUTHORIZATION_PRIVATE_KEY: "" }), { fetch });
    expect(shared.sender.address).toBe(identity.address);
    expect(shared.prerequisites).toEqual(["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_IDENTITY_WALLET_ID",
      "PRIVY_IDENTITY_ADDRESS", "PRIVY_IDENTITY_AUTHORIZATION_PRIVATE_KEY"]);
    expect(loadGatewaySigners(privyEnv(), { fetch }).prerequisites).toHaveLength(8);
  });

  it("sign envelopes as personal_sign over the raw hash, authorized by the role's signer key", async () => {
    const api = privyApi();
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    const envelope = await signEnvelope({ artifactType: "QuoteV1", environment: "testnet", chainId: 84532,
      audience: "https://gateway.example", signerKeyId: "gateway-quote", account: signers.identity.account,
      issuedAt: 1, validBefore: 2, payload: { value: 1 } });
    const { signature, ...unsigned } = envelope;
    expect(signature).toBe(await signEnvelope({ ...unsigned, account: identity }).then((local) => local.signature));
    expect(await recoverMessageAddress({ message: { raw: canonicalHash(unsigned) }, signature })).toBe(identity.address);
    const call = api.calls.at(-1)!;
    expect(call).toMatchObject({ method: "POST", url: "/v1/wallets/wallet-identity/rpc" });
    expect(call.body).toMatchObject({ method: "personal_sign", chain_type: "ethereum" });
    expect(call.headers.get("privy-app-id")).toBe("app-test");
    expect(call.headers.get("privy-authorization-signature")).toBeTruthy();
  });

  it("sign typed data through eth_signTypedData_v4", async () => {
    const api = privyApi();
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    const typed = {
      domain: { name: "Daski Reputation", version: "1", chainId: 84532, verifyingContract: `0x${"55".repeat(20)}` as Hex },
      types: { Order: [{ name: "orderKey", type: "bytes32" }, { name: "validBefore", type: "uint64" }] },
      primaryType: "Order" as const,
      message: { orderKey: `0x${"66".repeat(32)}` as Hex, validBefore: 1_900_000_000n },
    };
    const signature = await signers.identity.account.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(identity.address);
    expect(api.calls.at(-1)!.body).toMatchObject({ method: "eth_signTypedData_v4" });
  });

  it("returns a signed transaction only when every field equals the request, nonce 0 and value 0 included", async () => {
    const api = privyApi();
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    const request = transaction();
    const signed = await signers.sender.account.signTransaction(request);
    expect(parseTransaction(signed)).toMatchObject({ nonce: 0, chainId: 84532, gas: 150_000n });
    // The SDK dropped nonce 0 and value 0 on the wire; the fields still match.
    const sent = (api.calls.at(-1)!.body!.params as { transaction: Record<string, unknown> }).transaction;
    expect(sent.nonce).toBeUndefined();
    expect(sent.value).toBeUndefined();
    expect(signers.sender.healthy()).toBe(true);
  });

  it("refuses a signed transaction that differs from the request and marks the role unhealthy", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const tampered = privyApi({
      respond: async (call) => {
        if (call.body?.method !== "eth_signTransaction") return null;
        const signed = await sender.signTransaction(transaction({ gas: 21_000n }));
        return new Response(JSON.stringify({ method: "eth_signTransaction", data: { signed_transaction: signed, encoding: "rlp" } }),
          { headers: { "content-type": "application/json" } });
      },
    });
    const signers = loadGatewaySigners(privyEnv(), { fetch: tampered.fetch });
    await expect(signers.sender.account.signTransaction(transaction())).rejects.toMatchObject({
      name: "SignerRefused", reason: "SIGNED_GAS_MISMATCH",
    });
    expect(signers.sender.status()).toMatchObject({ status: "unhealthy", reason: "signed_result_mismatch", refusals: 1 });
    expect(signersHealthy(signers)).toBe(false);
    // Another signer's signature over the requested fields is refused too.
    const impostor = privyApi({
      respond: async (call) => {
        if (call.body?.method !== "eth_signTransaction") return null;
        const signed = await identity.signTransaction(transaction());
        return new Response(JSON.stringify({ method: "eth_signTransaction", data: { signed_transaction: signed, encoding: "rlp" } }),
          { headers: { "content-type": "application/json" } });
      },
    });
    await expect(loadGatewaySigners(privyEnv(), { fetch: impostor.fetch }).sender.account.signTransaction(transaction()))
      .rejects.toMatchObject({ reason: "SIGNED_SIGNER_MISMATCH" });
  });

  it("maps policy denials to SignerRefused and outages to SignerUnavailable, with no retries", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let answer: () => Response | Promise<Response> = () => new Response(JSON.stringify({ error: "Policy denied" }),
      { status: 403, headers: { "content-type": "application/json" } });
    const api = privyApi({ respond: (call) => call.body?.method ? answer() : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    const message = { message: { raw: `0x${"01".repeat(32)}` as Hex } };
    await expect(signers.identity.account.signMessage(message)).rejects.toMatchObject({ name: "SignerRefused", reason: "HTTP_403" });
    expect(signers.identity.healthy()).toBe(false);

    answer = () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    const before = api.calls.length;
    await expect(signers.identity.account.signMessage(message)).rejects.toBeInstanceOf(SignerUnavailable);
    expect(api.calls.length - before).toBe(1);
    answer = () => new Response("{}", { status: 429, headers: { "content-type": "application/json" } });
    await expect(signers.identity.account.signMessage(message)).rejects.toBeInstanceOf(SignerUnavailable);
    // A timeout is unavailable too; SIGNER_TIMEOUT_MS bounds it.
    answer = () => new Promise<Response>(() => undefined);
    const started = Date.now();
    await expect(signers.identity.account.signMessage(message)).rejects.toBeInstanceOf(SignerUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signers.identity.status()).toMatchObject({ status: "unhealthy" });

    // A signature that succeeds restores health.
    answer = async () => new Response(JSON.stringify({ method: "personal_sign",
      data: { signature: await identity.signMessage(message), encoding: "hex" } }), { headers: { "content-type": "application/json" } });
    await signers.identity.account.signMessage(message);
    expect(signers.identity.status()).toMatchObject({ status: "healthy", refusals: 1 });
  });

  it("marks a role unhealthy after three consecutive unavailable answers", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const api = privyApi({ respond: (call) => call.body?.method
      ? new Response("{}", { status: 502, headers: { "content-type": "application/json" } }) : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    const message = { message: { raw: `0x${"02".repeat(32)}` as Hex } };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(signers.identity.account.signMessage(message)).rejects.toBeInstanceOf(SignerUnavailable);
      expect(signers.identity.healthy()).toBe(attempt < 3);
    }
    expect(signers.identity.status().reason).toBe("signer_unavailable");
    expect(signers.sender.healthy()).toBe(true);
  });

  it("never sends a raw-hash or plain-string signature request", async () => {
    const api = privyApi();
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await expect(signers.identity.account.sign!({ hash: `0x${"03".repeat(32)}` })).rejects.toThrow("RAW_HASH_SIGNING_FORBIDDEN");
    await expect(signers.identity.account.signMessage({ message: "0xdeadbeef" })).rejects.toThrow("MESSAGE_MUST_BE_RAW");
    expect(api.calls).toHaveLength(0);
  });

  it("verify the wallet's address and that this role's signer is attached with an override policy", async () => {
    await expect(verifySigners(loadGatewaySigners(privyEnv(), { fetch: privyApi().fetch }))).resolves.toBeUndefined();

    const moved = loadGatewaySigners(privyEnv(), { fetch: privyApi({ wallets: {
      "wallet-identity": { address: sender.address, signers: [{ signer_id: "quorum-identity", override_policy_ids: ["p"] }] },
      "wallet-sender": { address: sender.address, signers: [{ signer_id: "quorum-sender", override_policy_ids: ["p"] }] },
    } }).fetch });
    await expect(verifySigners(moved)).rejects.toThrow("PRIVY_IDENTITY_ADDRESS does not match its Privy wallet");
    expect(moved.identity.status()).toMatchObject({ status: "unhealthy", reason: "signer_detached" });

    const noPolicy = loadGatewaySigners(privyEnv(), { fetch: privyApi({ wallets: {
      "wallet-identity": { address: identity.address, signers: [{ signer_id: "quorum-identity" }] },
      "wallet-sender": { address: sender.address, signers: [{ signer_id: "quorum-sender", override_policy_ids: ["p"] }] },
    } }).fetch });
    await expect(verifySigners(noPolicy)).rejects.toThrow("The identity signer is not attached to its Privy wallet with an override policy");

    const removed = loadGatewaySigners(privyEnv(), { fetch: privyApi({
      quorums: { "quorum-identity": [p256().publicKey], "quorum-sender": [senderSigner.publicKey] },
    }).fetch });
    await expect(verifySigners(removed)).rejects.toThrow("not attached");
    expect(signersHealthy(removed)).toBe(false);
    expect(removed.sender.healthy()).toBe(true);
  });

  it("keeps the last attachment state when Privy cannot be read", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let down = false;
    const api = privyApi({ respond: () => down ? new Response("{}", { status: 500, headers: { "content-type": "application/json" } }) : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await verifySigners(signers);
    down = true;
    await expect(verifySigners(signers)).rejects.toBeInstanceOf(SignerUnavailable);
    expect(signersHealthy(signers)).toBe(true);
  });
});

describe("the release path through viem", () => {
  const RELEASE_ALL = toFunctionSelector("function releaseAll() returns (uint256)");
  // viem prepares the transaction (nonce, gas, fees), the role signs it, and
  // only a transaction matching every requested field is broadcast.
  async function release(account: import("viem/accounts").LocalAccount) {
    const { createWalletClient, custom, parseAbi, keccak256 } = await import("viem");
    const { baseSepolia } = await import("viem/chains");
    const sent: Hex[] = [];
    const transport = custom({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case "eth_chainId": return "0x14a34";
          case "eth_getTransactionCount": return "0x0";
          case "eth_estimateGas": return "0x186a0";
          case "eth_maxPriorityFeePerGas": return "0xf4240";
          case "eth_getBlockByNumber": return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1",
            hash: `0x${"ab".repeat(32)}`, transactions: [] };
          case "eth_sendRawTransaction": { const raw = (params as Hex[])[0]!; sent.push(raw); return keccak256(raw); }
          default: throw new Error(`unexpected ${method}`);
        }
      },
    });
    const wallet = createWalletClient({ account, chain: baseSepolia, transport });
    const hash = await wallet.writeContract({ address: `0x${"77".repeat(20)}`, abi: parseAbi(["function releaseAll() returns (uint256)"]),
      functionName: "releaseAll" });
    return { hash, sent };
  }

  it("signs and broadcasts releaseAll with a local sender, nonce 0 and value 0 included", async () => {
    const { sent } = await release(loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey, GATEWAY_SENDER_PRIVATE_KEY: senderKey })
      .sender.account);
    expect(sent).toHaveLength(1);
    expect(parseTransaction(sent[0]!)).toMatchObject({ type: "eip1559", chainId: 84532, nonce: 0, gas: 100_000n,
      to: `0x${"77".repeat(20)}`, data: RELEASE_ALL });
  });

  it("does the same through Privy, which receives no nonce or value and fills nothing", async () => {
    const api = privyApi();
    const { sent } = await release(loadGatewaySigners(privyEnv(), { fetch: api.fetch }).sender.account);
    expect(sent).toHaveLength(1);
    expect(parseTransaction(sent[0]!)).toMatchObject({ chainId: 84532, nonce: 0, gas: 100_000n });
    const tx = (api.calls.at(-1)!.body!.params as { transaction: Record<string, unknown> }).transaction;
    expect(tx).toMatchObject({ type: 2, chain_id: 84532, to: `0x${"77".repeat(20)}`, data: RELEASE_ALL });
    expect(tx.nonce).toBeUndefined();
  });
});

describe("recovery of an unhealthy role", () => {
  it("probes only unhealthy Privy roles, within each role's policy, and recovers on success", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let failing = true;
    const api = privyApi({ respond: (call) => failing && call.body?.method
      ? new Response(JSON.stringify({ error: "denied" }), { status: 403, headers: { "content-type": "application/json" } }) : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await probeSigners(signers, 84532);
    expect(api.calls).toHaveLength(0);

    const message = { message: { raw: `0x${"04".repeat(32)}` as Hex } };
    await expect(signers.identity.account.signMessage(message)).rejects.toBeInstanceOf(SignerRefused);
    await expect(signers.sender.account.signTransaction(transaction())).rejects.toBeInstanceOf(SignerRefused);
    expect(signersHealthy(signers)).toBe(false);
    // Still refused: the probes fail and the roles stay unhealthy.
    await probeSigners(signers, 84532);
    expect(signersHealthy(signers)).toBe(false);

    failing = false;
    const before = api.calls.length;
    await probeSigners(signers, 84532);
    expect(signersHealthy(signers)).toBe(true);
    const probes = api.calls.slice(before).map((call) => call.body);
    expect(probes).toHaveLength(2);
    expect(probes.find((body) => body?.method === "personal_sign")).toMatchObject({ params: { encoding: "hex" } });
    const sent = (probes.find((body) => body?.method === "eth_signTransaction")!.params as { transaction: Record<string, unknown> }).transaction;
    expect(sent).toMatchObject({ chain_id: 84532, to: "0x000000000000000000000000000000000000dEaD", nonce: Number.MAX_SAFE_INTEGER,
      data: toFunctionSelector("function releaseAll() returns (uint256)") });
    expect(sent.value).toBeUndefined();
  });

  it("never probes a local role", async () => {
    const signers = loadGatewaySigners({ FACILITATOR_PRIVATE_KEY: identityKey });
    const sign = vi.spyOn(signers.identity.account, "signMessage");
    await probeSigners(signers, 84532);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("what restores a role", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const typed = {
    domain: { name: "x402 receipt", version: "1", chainId: 1 },
    types: { Receipt: [{ name: "payer", type: "address" }] },
    primaryType: "Receipt" as const,
    message: { payer: `0x${"55".repeat(20)}` as Hex },
  };

  it("clears a refusal only when that same method succeeds", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let refuseTyped = true;
    const api = privyApi({ respond: (call) => refuseTyped && call.body?.method === "eth_signTypedData_v4"
      ? new Response(JSON.stringify({ error: "denied" }), { status: 403, headers: { "content-type": "application/json" } }) : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await expect(signers.identity.account.signTypedData(typed)).rejects.toBeInstanceOf(SignerRefused);
    // A message signature works, but the typed-data refusal stands, and the
    // probe, which cannot exercise typed data harmlessly, does not run.
    await signers.identity.account.signMessage({ message: { raw: `0x${"05".repeat(32)}` } });
    const before = api.calls.length;
    await probeSigners(signers, 84532);
    expect(api.calls.length).toBe(before);
    expect(signers.identity.status()).toMatchObject({ status: "unhealthy", reason: "signature_refused" });
    refuseTyped = false;
    await signers.identity.account.signTypedData(typed);
    expect(signers.identity.healthy()).toBe(true);
  });

  it("keeps a signed-result mismatch until restart", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let tamper = true;
    const api = privyApi({ respond: async (call) => {
      if (!tamper || call.body?.method !== "eth_signTransaction") return null;
      return ok({ method: "eth_signTransaction", data: { signed_transaction: await sender.signTransaction(transaction({ gas: 1n })),
        encoding: "rlp" } });
    } });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await expect(signers.sender.account.signTransaction(transaction())).rejects.toMatchObject({ reason: "SIGNED_GAS_MISMATCH" });
    tamper = false;
    await signers.sender.account.signTransaction(transaction());
    await probeSigners(signers, 84532);
    expect(signers.sender.status()).toMatchObject({ status: "unhealthy", reason: "signed_result_mismatch" });
  });

  it("re-reads a detached role on the probe tick and restores it once reattached", async () => {
    let detached = true;
    const api = privyApi({ respond: (call) => detached && call.url === "/v1/key_quorums/quorum-identity"
      ? ok({ id: "quorum-identity", authorization_keys: [{ public_key: p256().publicKey, display_name: null }],
        authorization_threshold: 1, display_name: null, user_ids: null }) : null });
    const signers = loadGatewaySigners(privyEnv(), { fetch: api.fetch });
    await expect(verifySigners(signers)).rejects.toThrow("not attached");
    expect(signers.identity.status()).toMatchObject({ status: "unhealthy", reason: "signer_detached" });
    detached = false;
    await probeSigners(signers, 84532);
    expect(signers.identity.healthy()).toBe(true);
  });

  it("bounds the whole request, response body included, by SIGNER_TIMEOUT_MS", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const api = privyApi({ respond: (call) => call.body?.method === "personal_sign"
      ? new Response(new ReadableStream({ start() { /* headers arrive, the body never completes */ } }),
        { headers: { "content-type": "application/json" } }) : null });
    const signers = loadGatewaySigners(privyEnv({ SIGNER_TIMEOUT_MS: "300" }), { fetch: api.fetch });
    const started = Date.now();
    await expect(signers.identity.account.signMessage({ message: { raw: `0x${"06".repeat(32)}` } }))
      .rejects.toBeInstanceOf(SignerUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
