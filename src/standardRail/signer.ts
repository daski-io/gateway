import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  getAddress,
  keccak256,
  parseTransaction,
  stringToBytes,
  toFunctionSelector,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerializable,
} from "viem";
import { privateKeyToAccount, toAccount, type LocalAccount } from "viem/accounts";
import { APIConnectionError, APIError, PrivyAPIError, PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { logger } from "../util/logger.js";

export const SIGNER_ROLES = ["identity", "sender"] as const;
export type SignerRole = typeof SIGNER_ROLES[number];
export type SignerBackend = "local" | "privy";

export const DEFAULT_SIGNER_TIMEOUT_MS = 5_000;
// The relayer signs inside a database transaction and its nonce lock: a slow
// signer must never hold them for the 90-second lock wait.
export const MAX_SIGNER_TIMEOUT_MS = 5_000;
/** Consecutive unavailable answers that mark a role unhealthy. */
const UNAVAILABLE_THRESHOLD = 3;
/** How often an unhealthy role is probed, so it can recover without live traffic. */
export const SIGNER_PROBE_INTERVAL_MS = 30_000;
// Harmless probe requests within each role's policy: a fixed 32-byte message
// for identity; for sender a signed, never broadcast releaseAll() whose nonce
// no account will ever reach.
const PROBE_MESSAGE = keccak256(stringToBytes("daski-gateway-signer-probe-v1"));
const PROBE_TARGET = "0x000000000000000000000000000000000000dEaD";
const PROBE_NONCE = Number.MAX_SAFE_INTEGER;
const PRIVY_KEY_PREFIXES = ["wallet-auth:", "wallet-api:"];

/** The signer could not answer (timeout, network, 5xx, 429): retryable. */
export class SignerUnavailable extends Error {
  constructor(readonly role: SignerRole, readonly method: string, options?: { cause?: unknown }) {
    super(`SIGNER_UNAVAILABLE:${role}:${method}`, options);
    this.name = "SignerUnavailable";
  }
}

/** The signer refused (a policy denial, or a signed result that differs from the request): not retryable. */
export class SignerRefused extends Error {
  constructor(readonly role: SignerRole, readonly method: string, readonly reason: string, options?: { cause?: unknown }) {
    super(`SIGNER_REFUSED:${role}:${method}:${reason}`, options);
    this.name = "SignerRefused";
  }
}

export interface SignerStatus {
  role: SignerRole;
  backend: SignerBackend;
  address: Address;
  status: "healthy" | "unhealthy";
  reason?: string;
  refusals: number;
}

/** Public request facts a refusal is logged with: never payloads. */
interface RequestFacts { target?: string; selector?: string; chainId?: number }

/**
 * One gateway signing role. `account` is a viem local account: messages are
 * signed only as `{ raw }` (EIP-191 over the bytes), typed data as EIP-712,
 * transactions sign only and never broadcast. Raw-hash signing is refused.
 */
export class GatewaySigner {
  readonly account: LocalAccount;
  private consecutiveUnavailable = 0;
  private refused = false;
  private detached: string | null = null;
  private refusals = 0;

  constructor(
    readonly role: SignerRole,
    readonly backend: SignerBackend,
    readonly address: Address,
    inner: LocalAccount,
    private readonly attachment: (() => Promise<void>) | null = null,
  ) {
    this.account = toAccount({
      address,
      sign: async () => { throw new SignerRefused(role, "secp256k1_sign", "RAW_HASH_SIGNING_FORBIDDEN"); },
      signMessage: async ({ message }) => {
        if (typeof message === "string") throw new SignerRefused(role, "personal_sign", "MESSAGE_MUST_BE_RAW");
        return this.observe("personal_sign", {}, () => inner.signMessage({ message }));
      },
      signTypedData: async (typedData) => {
        const domain = (typedData as { domain?: { chainId?: number | bigint; verifyingContract?: string } }).domain;
        return this.observe("eth_signTypedData_v4", {
          ...(domain?.verifyingContract ? { target: domain.verifyingContract } : {}),
          ...(domain?.chainId === undefined ? {} : { chainId: Number(domain.chainId) }),
        }, () => inner.signTypedData(typedData as Parameters<LocalAccount["signTypedData"]>[0]));
      },
      signTransaction: async (transaction, options) => {
        const facts = {
          ...(transaction.to ? { target: transaction.to } : {}),
          ...(transaction.data ? { selector: transaction.data.slice(0, 10) } : {}),
          ...(transaction.chainId === undefined ? {} : { chainId: transaction.chainId }),
        };
        return this.observe("eth_signTransaction", facts, async () => {
          const signed = await inner.signTransaction(transaction, options);
          await assertSignedAsRequested(role, address, transaction, signed);
          return signed;
        });
      },
    });
  }

  /** Healthy: attached (Privy), no refusal and fewer than three unavailable answers since the last success. */
  healthy(): boolean {
    return this.detached === null && !this.refused && this.consecutiveUnavailable < UNAVAILABLE_THRESHOLD;
  }

  status(): SignerStatus {
    const reason = this.detached ?? (this.refused ? "signature_refused"
      : this.consecutiveUnavailable >= UNAVAILABLE_THRESHOLD ? "signer_unavailable" : undefined);
    return { role: this.role, backend: this.backend, address: this.address,
      status: this.healthy() ? "healthy" : "unhealthy", ...(reason ? { reason } : {}), refusals: this.refusals };
  }

  /**
   * Privy: the wallet still has this address and this role's signer is still
   * attached with its override policy. Reading the wallet alone proves
   * nothing about signing, so real signing outcomes also count (healthy()).
   */
  async verify(): Promise<void> {
    if (!this.attachment) return;
    try {
      await this.attachment();
      this.detached = null;
    } catch (error) {
      // An unanswered read proves nothing either way; signing outcomes decide.
      if (!(error instanceof SignerUnavailable)) this.detached = "signer_detached";
      throw error;
    }
  }

  /**
   * Signs a harmless probe while the role is unhealthy. The gates refuse new
   * sales before anything is signed, so without it a role that failed with no
   * order in flight could never recover.
   */
  async probe(chainId: number): Promise<void> {
    if (this.backend === "local" || this.healthy() || this.detached !== null) return;
    if (this.role === "identity") {
      await this.account.signMessage({ message: { raw: PROBE_MESSAGE } });
      return;
    }
    await this.account.signTransaction({
      type: "eip1559", chainId, nonce: PROBE_NONCE, to: PROBE_TARGET,
      data: toFunctionSelector("function releaseAll() returns (uint256)"), value: 0n,
      gas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
    });
  }

  private async observe<T>(method: string, facts: RequestFacts, work: () => Promise<T>): Promise<T> {
    if (this.backend === "local") return work();
    try {
      const result = await work();
      this.consecutiveUnavailable = 0;
      this.refused = false;
      return result;
    } catch (caught) {
      const error = classify(this.role, method, caught);
      if (error instanceof SignerRefused) {
        this.refused = true;
        this.refusals += 1;
        logger.error("gateway signer refused", { role: this.role, method, reason: error.reason, ...facts });
      } else {
        this.consecutiveUnavailable += 1;
        logger.warn("gateway signer unavailable", {
          role: this.role, method, consecutive: this.consecutiveUnavailable, ...facts,
        });
      }
      throw error;
    }
  }
}

function classify(role: SignerRole, method: string, error: unknown): SignerUnavailable | SignerRefused {
  if (error instanceof SignerUnavailable || error instanceof SignerRefused) return error;
  // Timeouts and lost connections are APIConnectionError; an APIError
  // without a status never reached Privy's answer either.
  if (error instanceof APIConnectionError) return new SignerUnavailable(role, method, { cause: error });
  if (error instanceof APIError) {
    const status = error.status;
    if (status === undefined || status >= 500 || status === 429 || status === 408) {
      return new SignerUnavailable(role, method, { cause: error });
    }
    return new SignerRefused(role, method, `HTTP_${status}`, { cause: error });
  }
  if (error instanceof PrivyAPIError) return new SignerRefused(role, method, "REQUEST_REJECTED", { cause: error });
  return new SignerUnavailable(role, method, { cause: error });
}

/**
 * The SDK forwards only truthy fields (nonce 0 and value 0 are omitted) and
 * no access list, and Privy fills nothing: every field of the signed result
 * must equal the request before anything is persisted or broadcast.
 */
export async function assertSignedAsRequested(
  role: SignerRole,
  address: Address,
  request: TransactionSerializable,
  signed: Hex,
): Promise<void> {
  const mismatch = (field: string) => new SignerRefused(role, "eth_signTransaction", `SIGNED_${field}_MISMATCH`);
  let parsed: ReturnType<typeof parseTransaction>;
  try { parsed = parseTransaction(signed); } catch { throw mismatch("ENCODING"); }
  const expectedType = request.type ?? (request.maxFeePerGas !== undefined ? "eip1559" : "legacy");
  const same = (left: unknown, right: unknown) => (left ?? null) === (right ?? null);
  const quantity = (value: bigint | number | undefined) => value === undefined ? undefined : BigInt(value);
  if (parsed.type !== expectedType) throw mismatch("TYPE");
  if (request.chainId === undefined || parsed.chainId !== request.chainId) throw mismatch("CHAIN_ID");
  if (request.nonce === undefined || (parsed.nonce ?? 0) !== request.nonce) throw mismatch("NONCE");
  if (!same(parsed.to?.toLowerCase(), request.to?.toLowerCase())) throw mismatch("TO");
  if ((parsed.data ?? "0x").toLowerCase() !== (request.data ?? "0x").toLowerCase()) throw mismatch("DATA");
  if ((parsed.value ?? 0n) !== (request.value ?? 0n)) throw mismatch("VALUE");
  if (request.gas === undefined || parsed.gas !== request.gas) throw mismatch("GAS");
  if (!same(quantity(parsed.maxFeePerGas), quantity(request.maxFeePerGas)) ||
      !same(quantity(parsed.maxPriorityFeePerGas), quantity(request.maxPriorityFeePerGas)) ||
      !same(quantity(parsed.gasPrice), quantity(request.gasPrice))) throw mismatch("FEES");
  const accessList = (parsed as { accessList?: readonly unknown[] }).accessList ?? [];
  const requestedAccessList = (request as { accessList?: readonly unknown[] }).accessList ?? [];
  if (accessList.length !== 0 || requestedAccessList.length !== 0) throw mismatch("ACCESS_LIST");
  if (getAddress(await recoverTransactionAddress({ serializedTransaction: signed as never })) !== address) {
    throw mismatch("SIGNER");
  }
}

/** The envelope key IDs the identity role signs under. */
export type GatewayArtifactKeyId =
  "gateway-protocol" | "gateway-quote" | "gateway-dispatch" | "gateway-lifecycle" | "gateway-receipt";

export interface GatewaySigners {
  readonly backend: SignerBackend;
  readonly identity: GatewaySigner;
  readonly sender: GatewaySigner;
  /** Environment variable names the active backend needs: release prerequisites. */
  readonly prerequisites: readonly string[];
  /**
   * The signer for an artifact key ID: always the identity role at runtime.
   * Only the synthetic provider-wire contract gives each key ID its own key.
   */
  artifact(keyId: GatewayArtifactKeyId): GatewaySigner;
}

export function signersHealthy(signers: GatewaySigners): boolean {
  return signers.identity.healthy() && signers.sender.healthy();
}

export function signerStatuses(signers: GatewaySigners): SignerStatus[] {
  return [signers.identity.status(), signers.sender.status()];
}

/** Probes every unhealthy Privy role once; failures are already counted and logged. */
export async function probeSigners(signers: GatewaySigners, chainId: number): Promise<void> {
  await Promise.allSettled([signers.identity.probe(chainId), signers.sender.probe(chainId)]);
}

/** Verifies every Privy role; local roles need nothing. */
export async function verifySigners(signers: GatewaySigners): Promise<void> {
  const results = await Promise.allSettled([signers.identity.verify(), signers.sender.verify()]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

function privateKey(value: string | undefined, name: string): Hex {
  const key = value?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key) || /^0x0+$/.test(key)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return key as Hex;
}

function configuredAddress(env: NodeJS.ProcessEnv, name: string, required: boolean): Address | null {
  const value = env[name]?.trim();
  if (!value) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${name} must be a non-zero EVM address`);
  return getAddress(value);
}

function local(role: SignerRole, key: Hex): GatewaySigner {
  const account = privateKeyToAccount(key);
  return new GatewaySigner(role, "local", account.address, account);
}

/** Local signers from raw keys: today's behavior, and every test's. */
export function localGatewaySigners(identityKey: Hex, senderKey: Hex = identityKey, options: {
  prerequisites?: readonly string[];
  artifactKeys?: Partial<Record<GatewayArtifactKeyId, Hex>>;
} = {}): GatewaySigners {
  const identity = local("identity", identityKey);
  const artifacts = new Map(Object.entries(options.artifactKeys ?? {})
    .map(([keyId, key]) => [keyId, local("identity", key!)] as const));
  return {
    backend: "local",
    identity,
    sender: local("sender", senderKey),
    prerequisites: options.prerequisites ?? ["FACILITATOR_PRIVATE_KEY"],
    artifact: (keyId) => artifacts.get(keyId) ?? identity,
  };
}

function signerTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.SIGNER_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : DEFAULT_SIGNER_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > MAX_SIGNER_TIMEOUT_MS) {
    throw new Error(`SIGNER_TIMEOUT_MS must be an integer from 100 to ${MAX_SIGNER_TIMEOUT_MS}`);
  }
  return value;
}

/** The SPKI DER of a P-256 key, from a base64 PKCS8 private key (optionally prefixed) or a public key. */
function spki(key: string, kind: "private" | "public"): Buffer {
  let text = key.trim();
  for (const prefix of PRIVY_KEY_PREFIXES) if (text.startsWith(prefix)) text = text.slice(prefix.length);
  if (kind === "private") {
    const der = Buffer.from(text.replace(/\s+/g, ""), "base64");
    return createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" }))
      .export({ format: "der", type: "spki" });
  }
  if (text.includes("BEGIN PUBLIC KEY")) return createPublicKey(text).export({ format: "der", type: "spki" });
  return createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" })
    .export({ format: "der", type: "spki" });
}

interface PrivyRole {
  role: SignerRole;
  walletId: string;
  address: Address;
  authorizationKey: string;
  names: string[];
}

function privyRole(env: NodeJS.ProcessEnv, role: SignerRole, fallback: PrivyRole | null): PrivyRole {
  const prefix = `PRIVY_${role.toUpperCase()}_`;
  const names = [`${prefix}WALLET_ID`, `${prefix}ADDRESS`, `${prefix}AUTHORIZATION_PRIVATE_KEY`];
  const present = names.filter((name) => env[name]?.trim());
  // The sender may share the identity's wallet and signer today.
  if (present.length === 0 && fallback) return { ...fallback, role };
  if (present.length !== names.length) throw new Error(`${names.join(", ")} must all be set for SIGNER_BACKEND=privy`);
  const walletId = env[names[0]!]!.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(walletId)) throw new Error(`${names[0]} is malformed`);
  const authorizationKey = env[names[2]!]!.trim();
  try { spki(authorizationKey, "private"); } catch { throw new Error(`${names[2]} must be a base64 PKCS8 P-256 private key`); }
  return { role, walletId, address: configuredAddress(env, names[1]!, true)!, authorizationKey, names };
}

/**
 * The gateway's two signing roles: `identity` signs protocol artifacts,
 * receipts and reputation permits; `sender` signs release and relayer
 * transactions. SIGNER_BACKEND=local (default) uses FACILITATOR_PRIVATE_KEY
 * and an optional GATEWAY_SENDER_PRIVATE_KEY, exactly as before. =privy signs
 * through Privy server wallets; the address is configuration, checked against
 * the wallet before the gateway serves (verifySigners).
 */
export function loadGatewaySigners(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {},
): GatewaySigners {
  const backend = env.SIGNER_BACKEND?.trim() || "local";
  if (backend === "local") {
    const identityKey = privateKey(env.FACILITATOR_PRIVATE_KEY, "FACILITATOR_PRIVATE_KEY");
    const senderRaw = env.GATEWAY_SENDER_PRIVATE_KEY?.trim();
    const senderKey = senderRaw ? privateKey(senderRaw, "GATEWAY_SENDER_PRIVATE_KEY") : identityKey;
    const signers = localGatewaySigners(identityKey, senderKey,
      { prerequisites: ["FACILITATOR_PRIVATE_KEY", ...(senderRaw ? ["GATEWAY_SENDER_PRIVATE_KEY"] : [])] });
    for (const signer of [signers.identity, signers.sender]) {
      const name = `PRIVY_${signer.role.toUpperCase()}_ADDRESS`;
      const expected = configuredAddress(env, name, false);
      if (expected && expected !== signer.address) throw new Error(`${name} does not match the ${signer.role} key`);
    }
    return signers;
  }
  if (backend !== "privy") throw new Error("SIGNER_BACKEND must be local or privy");
  const appId = env.PRIVY_APP_ID?.trim();
  const appSecret = env.PRIVY_APP_SECRET?.trim();
  if (!appId) throw new Error("PRIVY_APP_ID is required for SIGNER_BACKEND=privy");
  if (!appSecret) throw new Error("PRIVY_APP_SECRET is required for SIGNER_BACKEND=privy");
  const client = new PrivyClient({
    appId, appSecret, timeout: signerTimeout(env), maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const identity = privyRole(env, "identity", null);
  const sender = privyRole(env, "sender", identity);
  const signer = (role: PrivyRole) => new GatewaySigner(role.role, "privy", role.address,
    createViemAccount(client, {
      walletId: role.walletId, address: role.address,
      authorizationContext: { authorization_private_keys: [role.authorizationKey] },
    }) as unknown as LocalAccount,
    async () => {
      let wallet;
      try { wallet = await client.wallets().get(role.walletId); }
      catch (error) { throw classify(role.role, "wallet_read", error); }
      if (getAddress(wallet.address) !== role.address) {
        throw new Error(`PRIVY_${role.role.toUpperCase()}_ADDRESS does not match its Privy wallet`);
      }
      const ours = spki(role.authorizationKey, "private");
      for (const attached of wallet.additional_signers ?? []) {
        if (!attached.override_policy_ids?.length) continue;
        let quorum;
        try { quorum = await client.keyQuorums().get(attached.signer_id); }
        catch (error) { throw classify(role.role, "key_quorum_read", error); }
        if (quorum.authorization_keys.some((key) => {
          try { return spki(key.public_key, "public").equals(ours); } catch { return false; }
        })) return;
      }
      throw new Error(`The ${role.role} signer is not attached to its Privy wallet with an override policy`);
    });
  const identitySigner = signer(identity);
  return {
    backend: "privy",
    identity: identitySigner,
    sender: signer(sender),
    prerequisites: ["PRIVY_APP_ID", "PRIVY_APP_SECRET", ...identity.names,
      ...(sender.names === identity.names ? [] : sender.names)],
    artifact: () => identitySigner,
  };
}
