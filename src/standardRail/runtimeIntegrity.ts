import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "../config.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";

function workloadIdentityHash(): `0x${string}` {
  const railwayProjectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const railwayEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim();
  const railwayServiceId = process.env.RAILWAY_SERVICE_ID?.trim();
  if (!railwayProjectId || !railwayEnvironmentId || !railwayServiceId) {
    throw new Error("Railway project, environment, and service identity are required");
  }
  return canonicalHash({ railwayProjectId, railwayEnvironmentId, railwayServiceId });
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function measuredTreeHash(root: string): Promise<`0x${string}`> {
  const files = await filesUnder(root);
  const entries = await Promise.all(files.map(async (path) => ({
    path: relative(root, path).replaceAll("\\", "/"),
    contentHash: keccak256(bytesToHex(await readFile(path))),
  })));
  return canonicalHash(entries);
}

export async function measureRuntimeIntegrity(
  app: Config,
  rail: StandardRailConfig,
): Promise<Record<string, `0x${string}`>> {
  const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const lockfilePath = join(process.cwd(), "package-lock.json");
  const listingManifestHashes = rail.manifest.listings
    .map((listing) => canonicalHash(listing.manifest).toLowerCase()).sort();
  const providerControlProfileHashes = rail.manifest.listings
    .map((listing) => canonicalHash(listing.providerControlProfile).toLowerCase()).sort();
  const trustedSigners = [...rail.trustedSigners.entries()]
    .map(([keyId, address]) => ({ keyId, address: getAddress(address).toLowerCase() }))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
  const gatewayKeys = [
    ["dispatch", rail.dispatchPrivateKey], ["lifecycle", rail.lifecyclePrivateKey],
    ["quote", rail.quotePrivateKey], ["receipt", rail.receiptPrivateKey],
    ["refund", rail.refundPrivateKey], ["release", rail.releasePrivateKey],
  ].map(([role, key]) => ({
    role,
    address: privateKeyToAccount(key as `0x${string}`).address.toLowerCase(),
  }));
  const providerKeys = rail.manifest.listings.flatMap((listing) => [{
    role: `${listing.commitment.payload.providerAgentId}:authority`,
    address: getAddress(listing.commitment.payload.providerAuthorityKey).toLowerCase(),
  }, {
    role: `${listing.commitment.payload.providerAgentId}:terminal`,
    address: getAddress(listing.commitment.payload.providerTerminalAttestationKey).toLowerCase(),
  }, {
    role: `${listing.commitment.payload.providerAgentId}:refund-execution-reserve`,
    address: getAddress(listing.refundPolicy.executionReserveAddress).toLowerCase(),
  }]);
  return {
    gatewayReleaseDigest: canonicalHash({ gitCommit: rail.releaseCommit }),
    containerOrBinaryDigest: await measuredTreeHash(runtimeRoot),
    canonicalConfigurationHash: canonicalHash({
      environment: rail.environment,
      gatewayAudience: rail.gatewayAudience,
      chainId: app.chainId,
      network: app.x402Network,
      token: app.usdc,
      sanctionsOracleAddress: app.sanctionsOracleAddress.toLowerCase(),
      sanctionsOracleMode: app.sanctionsOracleMode,
      facilitatorBaseUrl: rail.facilitatorBaseUrl,
      evidenceRpcUrls: [...rail.evidenceRpcUrls].sort(),
      finalityConfirmations: rail.finalityConfirmations,
      facilitatorTimeoutMs: rail.facilitatorTimeoutMs,
      dispatchTimeoutMs: rail.dispatchTimeoutMs,
      leaseSeconds: rail.leaseSeconds,
      recoveryIntervalMs: rail.recoveryIntervalMs,
      refundMaxTransactionAmount: rail.refundMaxTransactionAmount,
      refundMaxReservedAmount: rail.refundMaxReservedAmount,
      refundMaxNetworkFeeWei: rail.refundMaxNetworkFeeWei,
      objectStore: {
        endpoint: rail.objectStore.endpoint,
        region: rail.objectStore.region,
        bucket: rail.objectStore.bucket,
        accessKeyId: rail.objectStore.accessKeyId,
      },
      uploadPolicy: rail.uploadPolicy,
    }),
    facilitatorCredentialBindingHash: canonicalHash(rail.manifest.facilitatorCredentialBinding),
    chainEvidencePolicyHash: canonicalHash(rail.manifest.chainEvidencePolicy),
    activeListingManifestSetHash: canonicalHash(listingManifestHashes),
    providerControlProfileSetHash: canonicalHash(providerControlProfileHashes),
    adapterArtifactSetHash: keccak256(bytesToHex(await readFile(lockfilePath))),
    keyPolicySetHash: canonicalHash({
      trustedSigners,
      gatewayKeys,
      providerKeys: providerKeys.sort((left, right) => left.role.localeCompare(right.role)),
      refundExecutionReserve: rail.refundExecutionReserveAddress.toLowerCase(),
    }),
    facilitatorProfileHash: canonicalHash(rail.manifest.facilitatorProfile),
    railCapabilityRequirementsHash: canonicalHash(rail.manifest.railCapabilityRequirements),
  };
}

export async function verifyRuntimeIntegrity(app: Config, rail: StandardRailConfig): Promise<void> {
  if (app.chainId !== 84_532 || rail.environment !== "testnet") {
    throw new Error(
      "Environment-backed standard-rail signers are restricted to Base Sepolia Testnet",
    );
  }
  if (!/^[0-9a-f]{40,64}$/.test(rail.releaseCommit)) {
    throw new Error("RAILWAY_GIT_COMMIT_SHA must be a 40-64 character hexadecimal commit digest");
  }
  const measured = await measureRuntimeIntegrity(app, rail);
  const runtime = rail.manifest.runtimeRelease.payload;
  for (const field of [
    "gatewayReleaseDigest", "containerOrBinaryDigest", "canonicalConfigurationHash",
    "facilitatorCredentialBindingHash", "chainEvidencePolicyHash", "activeListingManifestSetHash",
    "providerControlProfileSetHash", "adapterArtifactSetHash", "keyPolicySetHash",
  ] as const) {
    if (runtime[field].toLowerCase() !== measured[field]) {
      throw new Error(`Runtime integrity mismatch for ${field}`);
    }
  }
  const facilitator = rail.manifest.facilitatorProfile.payload;
  const credential = rail.manifest.facilitatorCredentialBinding.payload;
  if (
    rail.manifest.activeRailProfile.payload.facilitatorProfileHash.toLowerCase() !== measured.facilitatorProfileHash ||
    facilitator.baseUrl.replace(/\/$/, "") !== rail.facilitatorBaseUrl ||
    facilitator.network !== app.x402Network || getAddress(facilitator.asset) !== getAddress(app.usdc.address) ||
    facilitator.verifyTimeout !== rail.facilitatorTimeoutMs ||
    facilitator.settleTimeout !== rail.facilitatorTimeoutMs
  ) {
    throw new Error("Active rail profile does not match the configured facilitator");
  }
  if (
    credential.credentialKeyIdHash.toLowerCase() !==
      canonicalHash({ credentialKeyId: rail.facilitatorApiKeyId }).toLowerCase() ||
    credential.workloadIdentityHash.toLowerCase() !== workloadIdentityHash().toLowerCase()
  ) throw new Error("Facilitator credential or workload identity does not match its signed binding");
  for (const listing of rail.manifest.listings) {
    if (
      listing.commitment.payload.railCapabilityRequirementsHash.toLowerCase() !== measured.railCapabilityRequirementsHash ||
      getAddress(listing.screeningPolicy.sanctionsOracle) !== getAddress(app.sanctionsOracleAddress) ||
      getAddress(listing.refundPolicy.executionReserveAddress) !== rail.refundExecutionReserveAddress
    ) {
      throw new Error("Listing rail capability requirements are incompatible with the active rail");
    }
  }
  const gatewayRoleAddresses = new Set([
    rail.dispatchPrivateKey, rail.lifecyclePrivateKey, rail.quotePrivateKey,
    rail.receiptPrivateKey, rail.refundPrivateKey, rail.releasePrivateKey,
  ].map((key) => privateKeyToAccount(key).address.toLowerCase()));
  const externalRoleAddresses = rail.manifest.listings.flatMap((listing) => [
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.manifest.payload.splitterAddress,
    ...listing.screeningPolicy.providerControlledWallets,
  ]).map((address) => getAddress(address).toLowerCase());
  if (externalRoleAddresses.some((address) => gatewayRoleAddresses.has(address))) {
    throw new Error("Gateway operational keys overlap a provider, payout, splitter, or controlled-wallet role");
  }
}
