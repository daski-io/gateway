import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertNoDuplicateJsonKeys } from "./canonical.js";
import type { StandardRailManifest } from "./types.js";

export interface StandardRailConfig {
  environment: string;
  migrationDatabaseUrl: string;
  gatewayAudience: string;
  facilitatorBaseUrl: string;
  facilitatorApiKeyId: string;
  facilitatorApiKeySecret: string;
  evidenceRpcUrls: readonly [string, ...string[]];
  encryptionKey: Buffer;
  quotePrivateKey: Hex;
  dispatchPrivateKey: Hex;
  receiptPrivateKey: Hex;
  lifecyclePrivateKey: Hex;
  releasePrivateKey: Hex;
  trustedSigners: ReadonlyMap<string, Address>;
  manifest: StandardRailManifest;
  splitterFactoryRuntimeCodeHash: Hex;
  splitterCreationCodeHash: Hex;
  /** First-class deployment policy for dynamically registered listings —
   *  every splitter the registration flow prepares embeds these values. */
  dynamicListingPolicy: {
    splitterFactory: Address;
    daskiCommissionReceiver: Address;
    commissionBps: number;
    splitterCreationCode: Hex;
    splitterRuntimeCodeHash: Hex;
  };
  /** Sanctions screening pins applied to every dynamic listing. */
  screeningPolicy: {
    sanctionsOracle: Address;
    sanctionsOracleRuntimeCodeHash: Hex;
  };
  finalityConfirmations: number;
  facilitatorTimeoutMs: number;
  dispatchTimeoutMs: number;
  leaseSeconds: number;
  recoveryIntervalMs: number;
  readinessIntervalMs: number;
  cursorKeyRing: { activeKeyId: string; keys: ReadonlyMap<string, Buffer> };
  reputationContract: Address;
  easAddress: Address;
  reputationOutcomeSchemaUid: Hex;
  reputationConfirmationSchemaUid: Hex;
  reputationRetryDelaysSeconds: readonly [number, number, number, number];
  reputationOrderPrivateKey: Hex;
  reputationRelayerPrivateKey: Hex;
  reputationPermitTtlSeconds: number;
  reputationMaxFeePerGasWei: bigint;
  reputationMaxPriorityFeePerGasWei: bigint;
  reputationRegisterGasLimit: bigint;
  reputationConfirmationGasLimit: bigint;
  confirmationDeadlineSeconds: number;
  confirmationMaxPerOrder: number;
  confirmationMaxPerPayerPerDay: number;
  confirmationMaxGlobalPerDay: number;
  abuse: {
    walletChallengesPerClientPerMinute: number;
    walletChallengesGlobalPerMinute: number;
    walletChallengesOutstandingPerClient: number;
    walletChallengesOutstandingGlobal: number;
    protectedReadsPerPayerPerMinute: number;
    assetListsPerPayerPerMinute: number;
    assetStateChangesPerPayerPerMinute: number;
    federationGlobalConcurrency: number;
    federationPerProviderConcurrency: number;
    federationMaxProviders: number;
    federationPerProviderPerMinute: number;
    federationGlobalPerMinute: number;
  };
}

const DEFAULTS = {
  finalityConfirmations: 12,
  facilitatorTimeoutMs: 30_000,
  dispatchTimeoutMs: 90_000,
  leaseSeconds: 45,
  recoveryIntervalMs: 10_000,
  readinessIntervalMs: 300_000,
  reputationRetryDelaysSeconds: [5, 60, 3_000, 30_000] as const,
  abuse: {
    walletChallengesPerClientPerMinute: 30,
    walletChallengesGlobalPerMinute: 300,
    walletChallengesOutstandingPerClient: 20,
    walletChallengesOutstandingGlobal: 10_000,
    protectedReadsPerPayerPerMinute: 30,
    assetListsPerPayerPerMinute: 6,
    assetStateChangesPerPayerPerMinute: 10,
    federationGlobalConcurrency: 20,
    federationPerProviderConcurrency: 4,
    federationMaxProviders: 20,
    federationPerProviderPerMinute: 120,
    federationGlobalPerMinute: 300,
  },
} as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateKey(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return value as Hex;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveBigInt(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const value = env[name]?.trim() ?? fallback.toString();
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

function hash(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = required(env, name).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero bytes32 value`);
  }
  return value as Hex;
}

function httpsUrl(name: string, raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return value.href.replace(/\/$/, "");
}

function databaseUrl(raw: string): string {
  const value = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(value.protocol) || !value.hostname ||
      !value.username || value.pathname === '/') {
    throw new Error("MIGRATION_DATABASE_URL must identify a PostgreSQL database and role");
  }
  return raw;
}

function gunzipEnvelope(name: string, text: string, maxOutputLength: number): string {
  try {
    const prefix = "gzip-base64:";
    if (!text.startsWith(prefix)) throw new Error();
    const encoded = text.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    return gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength }).toString("utf8");
  } catch {
    throw new Error(`${name} is malformed`);
  }
}

function parseManifest(text: string): StandardRailManifest {
  try {
    const decoded = gunzipEnvelope("STANDARD_RAIL_MANIFEST_JSON", text, 1_000_000);
    assertNoDuplicateJsonKeys(decoded);
    return JSON.parse(decoded) as StandardRailManifest;
  } catch {
    throw new Error("STANDARD_RAIL_MANIFEST_JSON is malformed");
  }
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return getAddress(value);
}

function parseSplitterCreationCode(env: NodeJS.ProcessEnv, expectedHash: Hex): Hex {
  const decoded = gunzipEnvelope(
    "STANDARD_RAIL_SPLITTER_CREATION_CODE",
    required(env, "STANDARD_RAIL_SPLITTER_CREATION_CODE"),
    300_000,
  ).trim();
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(decoded) || decoded.length > 200_002) {
    throw new Error("STANDARD_RAIL_SPLITTER_CREATION_CODE must be EVM creation bytecode");
  }
  if (keccak256(decoded as Hex) !== expectedHash) {
    throw new Error("STANDARD_RAIL_SPLITTER_CREATION_CODE does not match its pinned hash");
  }
  return decoded as Hex;
}

function parseTrustedSigners(raw: string | undefined, protocolAddress: Address): ReadonlyMap<string, Address> {
  if (!raw?.trim()) return new Map([["gateway-protocol", protocolAddress]]);
  try {
    assertNoDuplicateJsonKeys(raw);
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(parsed).map(([keyId, address]) => [keyId, getAddress(address)]));
  } catch {
    throw new Error("STANDARD_RAIL_TRUSTED_SIGNERS_JSON is malformed");
  }
}

export function loadStandardRailConfig(
  env: NodeJS.ProcessEnv = process.env,
): StandardRailConfig {
  const manifest = parseManifest(required(env, "STANDARD_RAIL_MANIFEST_JSON"));
  const protocolPrivateKey = privateKey(env, "FACILITATOR_PRIVATE_KEY");
  const protocolAddress = privateKeyToAccount(protocolPrivateKey).address;
  const encryptionHex = required(env, "STANDARD_RAIL_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionHex)) {
    throw new Error("STANDARD_RAIL_ENCRYPTION_KEY must be 32 bytes of hex without 0x");
  }
  const encryptionKey = Buffer.from(encryptionHex, "hex");
  const cursorKey = createHash("sha256").update("daski:cursor:v1").update(encryptionKey).digest();
  const evidenceRpcUrls = [
    required(env, "BASE_RPC_URL"),
    ...(env.BASE_RPC_FALLBACK_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ].map((value, index) => httpsUrl(
    index === 0 ? "BASE_RPC_URL" : `BASE_RPC_FALLBACK_URLS[${index - 1}]`,
    value,
  ));
  const facilitatorBaseUrl = httpsUrl(
    "CDP_FACILITATOR_BASE_URL",
    env.CDP_FACILITATOR_BASE_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402",
  );
  const splitterCreationCodeHash = hash(env, "STANDARD_RAIL_SPLITTER_CREATION_CODE_HASH");
  const commissionBps = integer(env, "STANDARD_RAIL_COMMISSION_BPS", 0);
  if (commissionBps >= 10_000) {
    throw new Error("STANDARD_RAIL_COMMISSION_BPS must be below 10000");
  }
  const maxFee = positiveBigInt(env, "REPUTATION_MAX_FEE_PER_GAS_WEI", 100_000_000_000n);
  const priorityFee = positiveBigInt(env, "REPUTATION_MAX_PRIORITY_FEE_PER_GAS_WEI", 2_000_000_000n);
  const registerGas = positiveBigInt(env, "REPUTATION_REGISTER_GAS_LIMIT", 1_500_000n);
  const confirmationGas = positiveBigInt(env, "REPUTATION_CONFIRMATION_GAS_LIMIT", 750_000n);
  if (
    maxFee > 500_000_000_000n || priorityFee > 5_000_000_000n || priorityFee > maxFee
  ) throw new Error("Reputation relayer fee ceiling is invalid");
  return {
    environment: env.STANDARD_RAIL_ENVIRONMENT?.trim() || "testnet",
    migrationDatabaseUrl: databaseUrl(required(env, "MIGRATION_DATABASE_URL")),
    gatewayAudience: env.STANDARD_RAIL_GATEWAY_AUDIENCE?.trim() || required(env, "PUBLIC_URL"),
    facilitatorBaseUrl,
    facilitatorApiKeyId: required(env, "CDP_API_KEY_ID"),
    facilitatorApiKeySecret: required(env, "CDP_API_KEY_SECRET"),
    evidenceRpcUrls: evidenceRpcUrls as [string, ...string[]],
    encryptionKey,
    quotePrivateKey: protocolPrivateKey,
    dispatchPrivateKey: protocolPrivateKey,
    receiptPrivateKey: protocolPrivateKey,
    lifecyclePrivateKey: protocolPrivateKey,
    releasePrivateKey: protocolPrivateKey,
    trustedSigners: parseTrustedSigners(env.STANDARD_RAIL_TRUSTED_SIGNERS_JSON, protocolAddress),
    manifest,
    splitterFactoryRuntimeCodeHash: hash(env, "STANDARD_RAIL_SPLITTER_FACTORY_RUNTIME_CODE_HASH"),
    splitterCreationCodeHash,
    dynamicListingPolicy: {
      splitterFactory: address(env, "STANDARD_RAIL_SPLITTER_FACTORY"),
      daskiCommissionReceiver: address(env, "STANDARD_RAIL_COMMISSION_RECEIVER"),
      commissionBps,
      splitterCreationCode: parseSplitterCreationCode(env, splitterCreationCodeHash),
      splitterRuntimeCodeHash: hash(env, "STANDARD_RAIL_SPLITTER_RUNTIME_CODE_HASH"),
    },
    screeningPolicy: {
      sanctionsOracle: address(env, "STANDARD_RAIL_SANCTIONS_ORACLE"),
      sanctionsOracleRuntimeCodeHash: hash(env, "STANDARD_RAIL_SANCTIONS_ORACLE_RUNTIME_CODE_HASH"),
    },
    finalityConfirmations: integer(env, "STANDARD_RAIL_FINALITY_CONFIRMATIONS", DEFAULTS.finalityConfirmations),
    facilitatorTimeoutMs: integer(env, "STANDARD_RAIL_FACILITATOR_TIMEOUT_MS", DEFAULTS.facilitatorTimeoutMs),
    dispatchTimeoutMs: integer(env, "STANDARD_RAIL_DISPATCH_TIMEOUT_MS", DEFAULTS.dispatchTimeoutMs),
    leaseSeconds: integer(env, "STANDARD_RAIL_LEASE_SECONDS", DEFAULTS.leaseSeconds),
    recoveryIntervalMs: integer(env, "STANDARD_RAIL_RECOVERY_INTERVAL_MS", DEFAULTS.recoveryIntervalMs),
    readinessIntervalMs: integer(env, "STANDARD_RAIL_READINESS_INTERVAL_MS", DEFAULTS.readinessIntervalMs),
    cursorKeyRing: { activeKeyId: "derived-v1", keys: new Map([["derived-v1", cursorKey]]) },
    reputationContract: getAddress(required(env, "REPUTATION_STORAGE_ADDRESS")),
    easAddress: getAddress(required(env, "EAS_ADDRESS")),
    reputationOutcomeSchemaUid: hash(env, "EAS_OUTCOME_SCHEMA_UID"),
    reputationConfirmationSchemaUid: hash(env, "EAS_CONFIRMATION_SCHEMA_UID"),
    reputationRetryDelaysSeconds: DEFAULTS.reputationRetryDelaysSeconds,
    reputationOrderPrivateKey: protocolPrivateKey,
    reputationRelayerPrivateKey: protocolPrivateKey,
    reputationPermitTtlSeconds: integer(env, "REPUTATION_PERMIT_TTL_SECONDS", 900),
    reputationMaxFeePerGasWei: maxFee,
    reputationMaxPriorityFeePerGasWei: priorityFee,
    reputationRegisterGasLimit: registerGas,
    reputationConfirmationGasLimit: confirmationGas,
    confirmationDeadlineSeconds: 300,
    confirmationMaxPerOrder: 3,
    confirmationMaxPerPayerPerDay: 20,
    confirmationMaxGlobalPerDay: 500,
    abuse: { ...DEFAULTS.abuse },
  };
}
