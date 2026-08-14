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
  cursorKeyRing: {
    activeKeyId: string;
    keys: ReadonlyMap<string, Buffer>;
  };
  reputationContract: Address;
  reputationDeploymentBlock: bigint;
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
  reputationRefundGasLimit: bigint;
  reputationMinimumReserveWei: bigint;
  confirmationDeadlineSeconds: number;
  confirmationMaxPerOrder: number;
  confirmationMaxPerPayerPerDay: number;
  confirmationMaxGlobalPerDay: number;
  mirror: {
    registry: Address;
    privateKey: Hex;
    maxTransactionsPerOrder: number;
    maxTransactionsPerUtcDay: number;
    maxFeePerGasWei: bigint;
    maxPriorityFeePerGasWei: bigint;
    giveGasLimit: bigint;
    revokeGasLimit: bigint;
    minimumReserveWei: bigint;
  };
  notification: {
    privateKey: Hex;
    keyId: string;
    verificationTimeoutMs: number;
    verificationTtlSeconds: number;
    maxResponseBytes: number;
    maxPendingPerPayer: number;
    maxPendingGlobal: number;
    retryDelaysSeconds: readonly number[];
    maxAttempts: number;
  };
  admin: { bearerToken: string; csrfToken: string };
  marketplaceCommissionBps: number;
  launchOutcomeIds: readonly string[];
  abuse: {
    walletChallengesPerClientPerMinute: number;
    walletChallengesGlobalPerMinute: number;
    walletChallengesOutstandingPerClient: number;
    walletChallengesOutstandingGlobal: number;
    protectedReadsPerPayerPerMinute: number;
    assetListsPerPayerPerMinute: number;
    assetStateChangesPerPayerPerMinute: number;
    destructiveStagesPerPayerPerHour: number;
    federationGlobalConcurrency: number;
    federationPerProviderConcurrency: number;
    federationMaxProviders: number;
    federationPerProviderPerMinute: number;
    federationGlobalPerMinute: number;
  };
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

function requiredPositiveBigInt(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = required(env, name);
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return BigInt(value);
}

function requiredPositiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveAtomicAmount(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!/^[1-9]\d{0,77}$/.test(value)) {
    throw new Error(`${name} must be a positive uint256 decimal amount`);
  }
  return BigInt(value).toString();
}

function positiveBigInt(env: NodeJS.ProcessEnv, name: string): bigint {
  return BigInt(positiveAtomicAmount(env, name));
}

function hash(env: NodeJS.ProcessEnv, name: string): Hex {
  const value = required(env, name).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a bytes32 value`);
  return value as Hex;
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
  if (env.STANDARD_RAIL_COMMISSION_BPS !== undefined) {
    throw new Error("STANDARD_RAIL_COMMISSION_BPS is retired; use MARKETPLACE_COMMISSION_BPS");
  }
  const marketplaceCommissionBps = requiredPositiveInteger(env, "MARKETPLACE_COMMISSION_BPS");
  if (marketplaceCommissionBps !== 500) throw new Error("MARKETPLACE_COMMISSION_BPS must be 500");
  let launchOutcomeIds: string[];
  try { launchOutcomeIds = JSON.parse(required(env, "MARKETPLACE_LAUNCH_OUTCOME_IDS_JSON")); }
  catch { throw new Error("MARKETPLACE_LAUNCH_OUTCOME_IDS_JSON is malformed"); }
  if (launchOutcomeIds.length !== 3 || new Set(launchOutcomeIds).size !== 3 ||
    launchOutcomeIds.some((value) => !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value))) {
    throw new Error("The launch outcome allowlist must contain exactly three outcome IDs");
  }
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
  const reputationOrderPrivateKey = privateKey(env, "REPUTATION_ORDER_SIGNER_PRIVATE_KEY");
  const reputationRelayerPrivateKey = privateKey(env, "REPUTATION_RELAYER_PRIVATE_KEY");
  operationalAddresses.push(
    privateKeyToAccount(reputationOrderPrivateKey).address.toLowerCase(),
    privateKeyToAccount(reputationRelayerPrivateKey).address.toLowerCase(),
  );
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
  let cursorConfig: { activeKeyId: string; keys: Record<string, string> };
  let retryDelays: number[];
  try {
    cursorConfig = JSON.parse(required(env, "STANDARD_RAIL_CURSOR_KEYS_JSON"));
    retryDelays = JSON.parse(required(env, "REPUTATION_RETRY_DELAYS_SECONDS"));
  } catch {
    throw new Error("Cursor or reputation retry configuration is malformed");
  }
  const cursorKeys = new Map(Object.entries(cursorConfig.keys).map(([keyId, value]) => {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Cursor key ${keyId} is invalid`);
    return [keyId, Buffer.from(value, "hex")] as const;
  }));
  if (!cursorKeys.has(cursorConfig.activeKeyId)) throw new Error("Active cursor key is unavailable");
  if (
    JSON.stringify(retryDelays) !== JSON.stringify([5, 60, 3_000, 30_000])
  ) throw new Error("REPUTATION_RETRY_DELAYS_SECONDS must match the reviewed launch schedule");
  const facilitatorBaseUrl = httpsUrl(
    "CDP_FACILITATOR_BASE_URL",
    env.CDP_FACILITATOR_BASE_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402",
  );
  const facilitatorUrl = new URL(facilitatorBaseUrl);
  if (
    facilitatorUrl.hostname !== "api.cdp.coinbase.com" ||
    facilitatorUrl.port || facilitatorUrl.pathname !== "/platform/v2/x402"
  ) throw new Error("CDP_FACILITATOR_BASE_URL must be the pinned CDP x402 endpoint");
  const reputationMaxFeePerGasWei = positiveBigInt(env, "REPUTATION_MAX_FEE_PER_GAS_WEI");
  const reputationMaxPriorityFeePerGasWei = positiveBigInt(
    env,
    "REPUTATION_MAX_PRIORITY_FEE_PER_GAS_WEI",
  );
  const reputationRegisterGasLimit = positiveBigInt(env, "REPUTATION_REGISTER_GAS_LIMIT");
  const reputationConfirmationGasLimit = positiveBigInt(env, "REPUTATION_CONFIRMATION_GAS_LIMIT");
  const reputationRefundGasLimit = positiveBigInt(env, "REPUTATION_REFUND_GAS_LIMIT");
  const reputationMinimumReserveWei = positiveBigInt(env, "REPUTATION_MINIMUM_RESERVE_WEI");
  if (
    reputationMaxFeePerGasWei > 500_000_000_000n ||
    reputationMaxPriorityFeePerGasWei > 5_000_000_000n ||
    reputationMaxPriorityFeePerGasWei > reputationMaxFeePerGasWei ||
    reputationMinimumReserveWei < [
      reputationRegisterGasLimit,
      reputationConfirmationGasLimit,
      reputationRefundGasLimit,
    ].reduce((largest, value) => value > largest ? value : largest) * reputationMaxFeePerGasWei * 100n
  ) throw new Error("Reputation relayer fee ceiling or minimum reserve is invalid");
  const confirmationMaxPerOrder = requiredPositiveInteger(env, "CONFIRMATION_MAX_PER_ORDER");
  const confirmationMaxPerPayerPerDay = requiredPositiveInteger(
    env,
    "CONFIRMATION_MAX_PER_PAYER_PER_UTC_DAY",
  );
  const confirmationMaxGlobalPerDay = requiredPositiveInteger(
    env,
    "CONFIRMATION_MAX_GLOBAL_PER_UTC_DAY",
  );
  if (
    confirmationMaxPerOrder !== 3 || confirmationMaxPerPayerPerDay !== 20 ||
    confirmationMaxGlobalPerDay !== 500
  ) throw new Error("Confirmation sponsorship limits must match the reviewed launch release");
  const mirrorPrivateKey = privateKey(env, "MIRROR_CLIENT_PRIVATE_KEY");
  const mirrorMaxFeePerGasWei = positiveBigInt(env, "MIRROR_MAX_FEE_PER_GAS_WEI");
  const mirrorMaxPriorityFeePerGasWei = positiveBigInt(env, "MIRROR_MAX_PRIORITY_FEE_PER_GAS_WEI");
  const mirrorGiveGasLimit = positiveBigInt(env, "MIRROR_GIVE_GAS_LIMIT");
  const mirrorRevokeGasLimit = positiveBigInt(env, "MIRROR_REVOKE_GAS_LIMIT");
  const mirrorMinimumReserveWei = positiveBigInt(env, "MIRROR_MINIMUM_RESERVE_WEI");
  if (
    operationalAddresses.includes(privateKeyToAccount(mirrorPrivateKey).address.toLowerCase()) ||
    mirrorMaxFeePerGasWei > 500_000_000_000n ||
    mirrorMaxPriorityFeePerGasWei > 5_000_000_000n ||
    mirrorMaxPriorityFeePerGasWei > mirrorMaxFeePerGasWei ||
    mirrorMinimumReserveWei < (mirrorGiveGasLimit > mirrorRevokeGasLimit
      ? mirrorGiveGasLimit : mirrorRevokeGasLimit) * mirrorMaxFeePerGasWei * 100n
  ) throw new Error("Mirror key, fee ceiling, or minimum reserve is invalid");
  const notificationPrivateKey = privateKey(env, "ORDER_EVENT_SIGNING_PRIVATE_KEY");
  const notificationKeyId = required(env, "ORDER_EVENT_SIGNING_KEY_ID");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(notificationKeyId)) {
    throw new Error("ORDER_EVENT_SIGNING_KEY_ID is invalid");
  }
  const notificationAddress = privateKeyToAccount(notificationPrivateKey).address.toLowerCase();
  if (operationalAddresses.includes(notificationAddress) ||
    notificationAddress === privateKeyToAccount(mirrorPrivateKey).address.toLowerCase()) {
    throw new Error("The order-event signing key must be distinct from operational keys");
  }
  let notificationRetryDelays: number[];
  try {
    notificationRetryDelays = JSON.parse(required(env, "ORDER_EVENT_RETRY_DELAYS_SECONDS"));
  } catch {
    throw new Error("ORDER_EVENT_RETRY_DELAYS_SECONDS is malformed");
  }
  if (
    notificationRetryDelays.length < 2 || notificationRetryDelays.length > 10 ||
    notificationRetryDelays.some((value, index) =>
      !Number.isSafeInteger(value) || value < 1 || (index > 0 && value <= notificationRetryDelays[index - 1]!))
  ) throw new Error("ORDER_EVENT_RETRY_DELAYS_SECONDS must contain increasing delays");
  const notificationVerificationTtlSeconds = requiredPositiveInteger(
    env,
    "ORDER_EVENT_VERIFICATION_TTL_SECONDS",
  );
  const notificationMaxResponseBytes = requiredPositiveInteger(env, "ORDER_EVENT_MAX_RESPONSE_BYTES");
  const notificationMaxPendingPerPayer = requiredPositiveInteger(env, "ORDER_EVENT_MAX_PENDING_PER_PAYER");
  const notificationMaxPendingGlobal = requiredPositiveInteger(env, "ORDER_EVENT_MAX_PENDING_GLOBAL");
  if (notificationVerificationTtlSeconds > 300 || notificationMaxResponseBytes > 65_536 ||
    notificationMaxPendingPerPayer > 10 || notificationMaxPendingGlobal > 1_000) {
    throw new Error("Order-event verification limits exceed reviewed safety ceilings");
  }
  const mirrorMaxTransactionsPerOrder = requiredPositiveInteger(env, "MIRROR_MAX_TRANSACTIONS_PER_ORDER");
  const mirrorMaxTransactionsPerUtcDay = requiredPositiveInteger(env, "MIRROR_MAX_TRANSACTIONS_PER_UTC_DAY");
  if (mirrorMaxTransactionsPerOrder !== 5 || mirrorMaxTransactionsPerUtcDay !== 2_500) {
    throw new Error("Mirror transaction budgets must match the reviewed launch release");
  }
  const abuse = {
    walletChallengesPerClientPerMinute: requiredPositiveInteger(env, "WALLET_CHALLENGES_PER_CLIENT_PER_MINUTE"),
    walletChallengesGlobalPerMinute: requiredPositiveInteger(env, "WALLET_CHALLENGES_GLOBAL_PER_MINUTE"),
    walletChallengesOutstandingPerClient: requiredPositiveInteger(env, "WALLET_CHALLENGES_OUTSTANDING_PER_CLIENT"),
    walletChallengesOutstandingGlobal: requiredPositiveInteger(env, "WALLET_CHALLENGES_OUTSTANDING_GLOBAL"),
    protectedReadsPerPayerPerMinute: requiredPositiveInteger(env, "WALLET_PROTECTED_READS_PER_PAYER_PER_MINUTE"),
    assetListsPerPayerPerMinute: requiredPositiveInteger(env, "ASSET_LISTS_PER_PAYER_PER_MINUTE"),
    assetStateChangesPerPayerPerMinute: requiredPositiveInteger(env, "ASSET_STATE_CHANGES_PER_PAYER_PER_MINUTE"),
    destructiveStagesPerPayerPerHour: requiredPositiveInteger(env, "DESTRUCTIVE_STAGES_PER_PAYER_PER_HOUR"),
    federationGlobalConcurrency: requiredPositiveInteger(env, "FEDERATION_GLOBAL_CONCURRENCY"),
    federationPerProviderConcurrency: requiredPositiveInteger(env, "FEDERATION_PER_PROVIDER_CONCURRENCY"),
    federationMaxProviders: requiredPositiveInteger(env, "FEDERATION_MAX_PROVIDERS_PER_REQUEST"),
    federationPerProviderPerMinute: requiredPositiveInteger(env, "FEDERATION_PER_PROVIDER_PER_MINUTE"),
    federationGlobalPerMinute: requiredPositiveInteger(env, "FEDERATION_GLOBAL_PER_MINUTE"),
  };
  if (abuse.walletChallengesPerClientPerMinute !== 30 ||
    abuse.walletChallengesGlobalPerMinute !== 300 ||
    abuse.walletChallengesOutstandingPerClient !== 20 ||
    abuse.walletChallengesOutstandingGlobal !== 10_000 ||
    abuse.protectedReadsPerPayerPerMinute !== 30 || abuse.assetListsPerPayerPerMinute !== 6 ||
    abuse.assetStateChangesPerPayerPerMinute !== 10 || abuse.destructiveStagesPerPayerPerHour !== 3 ||
    abuse.federationGlobalConcurrency !== 40 || abuse.federationPerProviderConcurrency !== 4 ||
    abuse.federationMaxProviders !== 20 || abuse.federationPerProviderPerMinute !== 120 ||
    abuse.federationGlobalPerMinute !== 300) {
    throw new Error("Abuse and federation limits must match the reviewed launch release");
  }
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
    cursorKeyRing: { activeKeyId: cursorConfig.activeKeyId, keys: cursorKeys },
    reputationContract: getAddress(required(env, "REPUTATION_STORAGE_ADDRESS")),
    reputationDeploymentBlock: requiredPositiveBigInt(env, "REPUTATION_DEPLOYMENT_BLOCK"),
    easAddress: getAddress(required(env, "EAS_ADDRESS")),
    reputationOutcomeSchemaUid: hash(env, "REPUTATION_OUTCOME_SCHEMA_UID"),
    reputationConfirmationSchemaUid: hash(env, "REPUTATION_CONFIRMATION_SCHEMA_UID"),
    reputationRetryDelaysSeconds: retryDelays as [number, number, number, number],
    reputationOrderPrivateKey,
    reputationRelayerPrivateKey,
    reputationPermitTtlSeconds: requiredPositiveInteger(env, "REPUTATION_PERMIT_TTL_SECONDS"),
    reputationMaxFeePerGasWei,
    reputationMaxPriorityFeePerGasWei,
    reputationRegisterGasLimit,
    reputationConfirmationGasLimit,
    reputationRefundGasLimit,
    reputationMinimumReserveWei,
    confirmationDeadlineSeconds: requiredPositiveInteger(env, "CONFIRMATION_DEADLINE_SECONDS"),
    confirmationMaxPerOrder,
    confirmationMaxPerPayerPerDay,
    confirmationMaxGlobalPerDay,
    mirror: {
      registry: getAddress(required(env, "REPUTATION_REGISTRY_ADDRESS")),
      privateKey: mirrorPrivateKey,
      maxTransactionsPerOrder: mirrorMaxTransactionsPerOrder,
      maxTransactionsPerUtcDay: mirrorMaxTransactionsPerUtcDay,
      maxFeePerGasWei: mirrorMaxFeePerGasWei,
      maxPriorityFeePerGasWei: mirrorMaxPriorityFeePerGasWei,
      giveGasLimit: mirrorGiveGasLimit,
      revokeGasLimit: mirrorRevokeGasLimit,
      minimumReserveWei: mirrorMinimumReserveWei,
    },
    notification: {
      privateKey: notificationPrivateKey,
      keyId: notificationKeyId,
      verificationTimeoutMs: requiredPositiveInteger(env, "ORDER_EVENT_VERIFICATION_TIMEOUT_MS"),
      verificationTtlSeconds: notificationVerificationTtlSeconds,
      maxResponseBytes: notificationMaxResponseBytes,
      maxPendingPerPayer: notificationMaxPendingPerPayer,
      maxPendingGlobal: notificationMaxPendingGlobal,
      retryDelaysSeconds: notificationRetryDelays,
      maxAttempts: notificationRetryDelays.length + 1,
    },
    admin: {
      bearerToken: required(env, "STANDARD_RAIL_ADMIN_BEARER_TOKEN"),
      csrfToken: required(env, "STANDARD_RAIL_ADMIN_CSRF_TOKEN"),
    },
    marketplaceCommissionBps,
    launchOutcomeIds,
    abuse,
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
