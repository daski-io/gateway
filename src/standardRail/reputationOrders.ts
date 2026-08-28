import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, providerIdentitySnapshotHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardChainEvidence } from "./evidence.js";
import type {
  ProviderIdentitySnapshotV1,
  StandardListing,
  StandardOrderRecord,
} from "./types.js";
import type { ReputationOperationIntent } from "./reputationOperation.js";
import { isReputationEligiblePayer } from "./reputationEligibility.js";

export interface StandardReputationOrderV1 {
  orderKey: Hex;
  authorizationKey: Hex;
  providerAgentId: bigint;
  serviceId: Hex;
  payer: Hex;
  providerOwner: Hex;
  providerAgentWallet: Hex;
  providerPayee: Hex;
  identityRegistry: Hex;
  providerRegistry: Hex;
  serviceRegistry: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  canonicalToken: Hex;
  grossAmount: bigint;
  paidAt: bigint;
  providerIdentitySnapshotHash: Hex;
  listingManifestHash: Hex;
  releaseEvidenceHash: Hex;
  reputationEligible: boolean;
  validBefore: bigint;
}

const orderTypes = {
  StandardReputationOrderV1: [
    { name: "orderKey", type: "bytes32" },
    { name: "authorizationKey", type: "bytes32" },
    { name: "providerAgentId", type: "uint256" },
    { name: "serviceId", type: "bytes32" },
    { name: "payer", type: "address" },
    { name: "providerOwner", type: "address" },
    { name: "providerAgentWallet", type: "address" },
    { name: "providerPayee", type: "address" },
    { name: "identityRegistry", type: "address" },
    { name: "providerRegistry", type: "address" },
    { name: "serviceRegistry", type: "address" },
    { name: "blockNumber", type: "uint256" },
    { name: "blockHash", type: "bytes32" },
    { name: "canonicalToken", type: "address" },
    { name: "grossAmount", type: "uint256" },
    { name: "paidAt", type: "uint64" },
    { name: "providerIdentitySnapshotHash", type: "bytes32" },
    { name: "listingManifestHash", type: "bytes32" },
    { name: "releaseEvidenceHash", type: "bytes32" },
    { name: "reputationEligible", type: "bool" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

export async function buildReputationRegistration(args: {
  order: StandardOrderRecord;
  listing: StandardListing;
  deposit: { blockNumber: bigint; blockHash: Hex };
  releaseEvidenceHash: Hex;
  config: StandardRailConfig;
  chainId: number;
  marketplaceContracts: {
    identityRegistry: string;
    providerRegistry: string;
    serviceRegistry: string;
  };
  evidence: StandardChainEvidence;
}) {
  if (!args.order.payer || !args.order.authorizationKey) {
    throw new Error("Reputation registration requires finalized payer authority");
  }
  // Identity facts come from the registration record; the pinned block is the
  // splitter activation checkpoint, where those facts were last chain-proven.
  const snapshotPayload: ProviderIdentitySnapshotV1 = {
    providerAgentId: args.listing.commitment.payload.providerAgentId,
    serviceId: args.listing.commitment.payload.serviceId,
    identityRegistry: getAddress(args.marketplaceContracts.identityRegistry),
    providerRegistry: getAddress(args.marketplaceContracts.providerRegistry),
    serviceRegistry: getAddress(args.marketplaceContracts.serviceRegistry),
    providerOwner: getAddress(args.listing.providerOwner),
    providerAgentWallet: getAddress(args.listing.providerAgentWallet),
    providerPayee: getAddress(args.listing.commitment.payload.providerPayee),
    blockNumber: args.listing.manifest.payload.splitterActivationBlockNumber,
    blockHash: args.listing.manifest.payload.splitterActivationBlockHash,
  };
  const paidAt = await args.evidence.finalizedBlockTimestamp(
    args.deposit.blockNumber,
    args.deposit.blockHash,
  );
  const now = Math.floor(Date.now() / 1_000);
  const permit: StandardReputationOrderV1 = {
    orderKey: args.order.orderKey,
    authorizationKey: args.order.authorizationKey,
    providerAgentId: BigInt(snapshotPayload.providerAgentId),
    serviceId: snapshotPayload.serviceId,
    payer: getAddress(args.order.payer).toLowerCase() as Hex,
    providerOwner: snapshotPayload.providerOwner.toLowerCase() as Hex,
    providerAgentWallet: snapshotPayload.providerAgentWallet.toLowerCase() as Hex,
    providerPayee: snapshotPayload.providerPayee.toLowerCase() as Hex,
    identityRegistry: snapshotPayload.identityRegistry.toLowerCase() as Hex,
    providerRegistry: snapshotPayload.providerRegistry.toLowerCase() as Hex,
    serviceRegistry: snapshotPayload.serviceRegistry.toLowerCase() as Hex,
    blockNumber: BigInt(snapshotPayload.blockNumber),
    blockHash: snapshotPayload.blockHash,
    canonicalToken: getAddress(args.listing.commitment.payload.canonicalToken).toLowerCase() as Hex,
    grossAmount: BigInt(args.order.grossAmount),
    paidAt: BigInt(paidAt),
    providerIdentitySnapshotHash: providerIdentitySnapshotHash(snapshotPayload, args.chainId),
    listingManifestHash: args.order.listingManifestHash,
    releaseEvidenceHash: args.releaseEvidenceHash,
    reputationEligible: isReputationEligiblePayer(args.order.payer, args.listing, args.config),
    validBefore: BigInt(now + args.config.reputationPermitTtlSeconds),
  };
  const signature = await privateKeyToAccount(args.config.reputationOrderPrivateKey).signTypedData({
    domain: {
      name: "Daski Reputation",
      version: "1",
      chainId: args.chainId,
      verifyingContract: args.config.reputationContract,
    },
    primaryType: "StandardReputationOrderV1",
    types: orderTypes,
    message: permit,
  });
  const canonicalIntent = {
    operation: "register-order" as const,
    permit: {
      ...permit,
      providerAgentId: permit.providerAgentId.toString(),
      blockNumber: permit.blockNumber.toString(),
      grossAmount: permit.grossAmount.toString(),
      paidAt: permit.paidAt.toString(),
      validBefore: permit.validBefore.toString(),
    },
    signature,
  };
  return { canonicalIntent, intentHash: canonicalHash(canonicalIntent) };
}

export function reputationPermitDeadline(intent: ReputationOperationIntent): bigint | null {
  if (intent.operation === "register-order") {
    return BigInt(intent.permit.validBefore);
  }
  return null;
}

export async function refreshReputationPermit(
  intent: ReputationOperationIntent,
  config: StandardRailConfig,
  chainId: number,
): Promise<ReputationOperationIntent> {
  const validBefore = BigInt(Math.floor(Date.now() / 1_000) + config.reputationPermitTtlSeconds);
  const account = privateKeyToAccount(config.reputationOrderPrivateKey);
  const domain = {
    name: "Daski Reputation" as const,
    version: "1" as const,
    chainId,
    verifyingContract: config.reputationContract,
  };
  if (intent.operation === "register-order") {
    const permit = { ...intent.permit, validBefore: validBefore.toString() };
    const signature = await account.signTypedData({
      domain,
      primaryType: "StandardReputationOrderV1",
      types: orderTypes,
      message: {
        ...permit,
        providerAgentId: BigInt(permit.providerAgentId),
        blockNumber: BigInt(permit.blockNumber),
        grossAmount: BigInt(permit.grossAmount),
        paidAt: BigInt(permit.paidAt),
        validBefore,
      },
    });
    return { ...intent, permit, signature };
  }
  return intent;
}
