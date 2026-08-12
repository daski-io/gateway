import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StandardRailManifest } from "./types.js";
import { assertNoDuplicateJsonKeys } from "./canonical.js";

export interface StandardRailConfig {
  environment: string;
  releaseCommit: string;
  migrationDatabaseUrl: string;
  gatewayAudience: string;
  facilitatorBaseUrl: string;
  facilitatorApiKeyId: string;
  facilitatorApiKeySecret: string;
  evidenceRpcUrls: readonly [string, string, ...string[]];
  encryptionKey: Buffer;
  quotePrivateKey: Hex;
  dispatchPrivateKey: Hex;
  receiptPrivateKey: Hex;
  lifecyclePrivateKey: Hex;
  releasePrivateKey: Hex;
  refundPrivateKey: Hex;
  refundExecutionReserveAddress: Address;
  refundMaxTransactionAmount: string;
  refundMaxReservedAmount: string;
  refundMaxNetworkFeeWei: string;
  trustedSigners: ReadonlyMap<string, Address>;
  manifest: StandardRailManifest;
  finalityConfirmations: number;
  facilitatorTimeoutMs: number;
  dispatchTimeoutMs: number;
  leaseSeconds: number;
  recoveryIntervalMs: number;
  objectStore: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  uploadPolicy: {
    ttlSeconds: number;
    maxObjects: number;
    maxObjectBytes: number;
    maxAggregateBytes: number;
    allowedMediaTypes: string[];
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} env var is required for the standard rail`);
  return value;
}

function privateKey(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = required(env, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/.test(value)) {
    throw new Error(`${name} must be a non-zero 32-byte private key`);
  }
  return value as Hex;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveAtomicAmount(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[1-9]\d{0,77}$/.test(value)) {
    throw new Error(`${name} must be a positive uint256 decimal amount`);
  }
  return BigInt(value).toString();
}

function httpsUrl(name: string, value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials`);
  }
  return value.replace(/\/$/, "");
}

function databaseUrl(name: string, value: string): string {
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname || !parsed.pathname || parsed.pathname === "/" ||
    !parsed.username
  ) throw new Error(`${name} must be a PostgreSQL connection URL with a database and role`);
  return value;
}

export function loadStandardRailConfig(
  env: NodeJS.ProcessEnv = process.env,
): StandardRailConfig {
  const evidenceRpcUrls = required(env, "STANDARD_RAIL_EVIDENCE_RPC_URLS")
    .split(",")
    .map((url, index) => httpsUrl(`STANDARD_RAIL_EVIDENCE_RPC_URLS[${index}]`, url.trim()))
    .filter(Boolean);
  if (evidenceRpcUrls.length < 2 || new Set(evidenceRpcUrls.map((url) => new URL(url).hostname)).size < 2) {
    throw new Error("STANDARD_RAIL_EVIDENCE_RPC_URLS requires two independent hosts");
  }
  let trusted: Record<string, string>;
  let manifest: StandardRailManifest;
  try {
    const trustedText = required(env, "STANDARD_RAIL_TRUSTED_SIGNERS_JSON");
    const manifestText = required(env, "STANDARD_RAIL_MANIFEST_JSON");
    assertNoDuplicateJsonKeys(trustedText);
    assertNoDuplicateJsonKeys(manifestText);
    trusted = JSON.parse(trustedText);
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("Standard-rail JSON configuration is malformed");
  }
  const trustedSigners = new Map<string, Address>();
  for (const [keyId, address] of Object.entries(trusted)) {
    trustedSigners.set(keyId, getAddress(address));
  }
  if (trustedSigners.size === 0) throw new Error("STANDARD_RAIL_TRUSTED_SIGNERS_JSON cannot be empty");
  const encryptionHex = required(env, "STANDARD_RAIL_ENCRYPTION_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(encryptionHex)) {
    throw new Error("STANDARD_RAIL_ENCRYPTION_KEY must be 32 bytes of hex without 0x");
  }
  const refundPrivateKey = privateKey(env, "STANDARD_RAIL_REFUND_PRIVATE_KEY");
  const refundExecutionReserveAddress = getAddress(required(
    env,
    "STANDARD_RAIL_REFUND_EXECUTION_RESERVE_ADDRESS",
  ));
  if (privateKeyToAccount(refundPrivateKey).address !== refundExecutionReserveAddress) {
    throw new Error("STANDARD_RAIL_REFUND_EXECUTION_RESERVE_ADDRESS must match the refund key");
  }
  const refundMaxTransactionAmount = positiveAtomicAmount(
    env,
    "STANDARD_RAIL_REFUND_MAX_TRANSACTION_AMOUNT_ATOMIC",
  );
  const refundMaxReservedAmount = positiveAtomicAmount(
    env,
    "STANDARD_RAIL_REFUND_MAX_RESERVED_AMOUNT_ATOMIC",
  );
  const refundMaxNetworkFeeWei = positiveAtomicAmount(
    env,
    "STANDARD_RAIL_REFUND_MAX_NETWORK_FEE_WEI",
  );
  if (BigInt(refundMaxReservedAmount) < BigInt(refundMaxTransactionAmount)) {
    throw new Error("The aggregate refund cap cannot be lower than the transaction cap");
  }
  const quotePrivateKey = privateKey(env, "STANDARD_RAIL_QUOTE_PRIVATE_KEY");
  const dispatchPrivateKey = privateKey(env, "STANDARD_RAIL_DISPATCH_PRIVATE_KEY");
  const receiptPrivateKey = privateKey(env, "STANDARD_RAIL_RECEIPT_PRIVATE_KEY");
  const lifecyclePrivateKey = privateKey(env, "STANDARD_RAIL_LIFECYCLE_PRIVATE_KEY");
  const releasePrivateKey = privateKey(env, "STANDARD_RAIL_RELEASE_PRIVATE_KEY");
  const operationalAddresses = [
    quotePrivateKey, dispatchPrivateKey, receiptPrivateKey, lifecyclePrivateKey,
    releasePrivateKey, refundPrivateKey,
  ].map((value) => privateKeyToAccount(value).address.toLowerCase());
  if (new Set(operationalAddresses).size !== operationalAddresses.length) {
    throw new Error("Standard-rail operational roles require distinct private keys");
  }
  const maxObjectBytes = positiveInteger(env, "STANDARD_RAIL_UPLOAD_MAX_OBJECT_BYTES", 400_000);
  const maxAggregateBytes = positiveInteger(env, "STANDARD_RAIL_UPLOAD_MAX_AGGREGATE_BYTES", 600_000);
  const maxObjects = positiveInteger(env, "STANDARD_RAIL_UPLOAD_MAX_OBJECTS", 5);
  const allowedMediaTypes = required(env, "STANDARD_RAIL_UPLOAD_ALLOWED_MEDIA_TYPES")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (maxObjects > 20 || maxObjectBytes > 400_000 || maxAggregateBytes > 600_000 ||
      maxObjectBytes > maxAggregateBytes) {
    throw new Error("Standard-rail upload limits exceed the bounded dispatch envelope");
  }
  if (new Set(allowedMediaTypes).size !== allowedMediaTypes.length) {
    throw new Error("STANDARD_RAIL_UPLOAD_ALLOWED_MEDIA_TYPES contains duplicates");
  }
  const facilitatorBaseUrl = httpsUrl(
    "CDP_FACILITATOR_BASE_URL",
    env.CDP_FACILITATOR_BASE_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402",
  );
  const facilitatorUrl = new URL(facilitatorBaseUrl);
  if (
    facilitatorUrl.hostname !== "api.cdp.coinbase.com" ||
    facilitatorUrl.port || facilitatorUrl.pathname !== "/platform/v2/x402"
  ) throw new Error("CDP_FACILITATOR_BASE_URL must be the pinned CDP x402 endpoint");
  return {
    environment: required(env, "STANDARD_RAIL_ENVIRONMENT"),
    releaseCommit: required(env, "RAILWAY_GIT_COMMIT_SHA").toLowerCase(),
    migrationDatabaseUrl: databaseUrl(
      "MIGRATION_DATABASE_URL",
      required(env, "MIGRATION_DATABASE_URL"),
    ),
    gatewayAudience: required(env, "STANDARD_RAIL_GATEWAY_AUDIENCE"),
    facilitatorBaseUrl,
    facilitatorApiKeyId: required(env, "CDP_API_KEY_ID"),
    facilitatorApiKeySecret: required(env, "CDP_API_KEY_SECRET"),
    evidenceRpcUrls: evidenceRpcUrls as [string, string, ...string[]],
    encryptionKey: Buffer.from(encryptionHex, "hex"),
    quotePrivateKey,
    dispatchPrivateKey,
    receiptPrivateKey,
    lifecyclePrivateKey,
    releasePrivateKey,
    refundPrivateKey,
    refundExecutionReserveAddress,
    refundMaxTransactionAmount,
    refundMaxReservedAmount,
    refundMaxNetworkFeeWei,
    trustedSigners,
    manifest,
    finalityConfirmations: positiveInteger(env, "STANDARD_RAIL_FINALITY_CONFIRMATIONS", 12),
    facilitatorTimeoutMs: positiveInteger(env, "STANDARD_RAIL_FACILITATOR_TIMEOUT_MS", 30_000),
    dispatchTimeoutMs: positiveInteger(env, "STANDARD_RAIL_DISPATCH_TIMEOUT_MS", 90_000),
    leaseSeconds: positiveInteger(env, "STANDARD_RAIL_LEASE_SECONDS", 45),
    recoveryIntervalMs: positiveInteger(env, "STANDARD_RAIL_RECOVERY_INTERVAL_MS", 10_000),
    objectStore: {
      endpoint: httpsUrl("STANDARD_RAIL_OBJECT_STORE_ENDPOINT", required(env, "STANDARD_RAIL_OBJECT_STORE_ENDPOINT")),
      region: required(env, "STANDARD_RAIL_OBJECT_STORE_REGION"),
      bucket: required(env, "STANDARD_RAIL_OBJECT_STORE_BUCKET"),
      accessKeyId: required(env, "STANDARD_RAIL_OBJECT_STORE_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "STANDARD_RAIL_OBJECT_STORE_SECRET_ACCESS_KEY"),
    },
    uploadPolicy: {
      ttlSeconds: positiveInteger(env, "STANDARD_RAIL_UPLOAD_TTL_SECONDS", 900),
      maxObjects,
      maxObjectBytes,
      maxAggregateBytes,
      allowedMediaTypes,
    },
  };
}
