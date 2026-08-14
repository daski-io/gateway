import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash, providerIdentitySnapshotHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import type { StandardChainEvidence } from "./evidence.js";
import type {
  StandardListing,
  StandardOrderRecord,
} from "./types.js";

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
  evidence: StandardChainEvidence;
}) {
  if (!args.order.payer || !args.order.authorizationKey) {
    throw new Error("Reputation registration requires finalized payer authority");
  }
  const snapshot = args.config.manifest.providerIdentitySnapshots.find((item) =>
    providerIdentitySnapshotHash(item.payload, args.chainId) ===
      args.listing.commitment.payload.providerIdentitySnapshotHash
  );
  if (!snapshot) throw new Error("Reputation identity snapshot is unavailable");
  const paidAt = await args.evidence.finalizedBlockTimestamp(
    args.deposit.blockNumber,
    args.deposit.blockHash,
  );
  const now = Math.floor(Date.now() / 1_000);
  const permit: StandardReputationOrderV1 = {
    orderKey: args.order.orderKey,
    authorizationKey: args.order.authorizationKey,
    providerAgentId: BigInt(snapshot.payload.providerAgentId),
    serviceId: snapshot.payload.serviceId,
    payer: getAddress(args.order.payer).toLowerCase() as Hex,
    providerOwner: getAddress(snapshot.payload.providerOwner).toLowerCase() as Hex,
    providerAgentWallet: getAddress(snapshot.payload.providerAgentWallet).toLowerCase() as Hex,
    providerPayee: getAddress(snapshot.payload.providerPayee).toLowerCase() as Hex,
    identityRegistry: getAddress(snapshot.payload.identityRegistry).toLowerCase() as Hex,
    providerRegistry: getAddress(snapshot.payload.providerRegistry).toLowerCase() as Hex,
    serviceRegistry: getAddress(snapshot.payload.serviceRegistry).toLowerCase() as Hex,
    blockNumber: BigInt(snapshot.payload.blockNumber),
    blockHash: snapshot.payload.blockHash,
    canonicalToken: getAddress(args.listing.commitment.payload.canonicalToken).toLowerCase() as Hex,
    grossAmount: BigInt(args.order.grossAmount),
    paidAt: BigInt(paidAt),
    providerIdentitySnapshotHash: args.listing.commitment.payload.providerIdentitySnapshotHash,
    listingManifestHash: args.order.listingManifestHash,
    releaseEvidenceHash: args.releaseEvidenceHash,
    reputationEligible: true,
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

const refundTypes = {
  StandardReputationRefundV1: [
    { name: "orderKey", type: "bytes32" },
    { name: "authorizationKey", type: "bytes32" },
    { name: "cumulativeRefundedAmount", type: "uint256" },
    { name: "refundEvidenceHash", type: "bytes32" },
    { name: "validBefore", type: "uint64" },
  ],
} as const;

export async function buildReputationRefund(args: {
  order: StandardOrderRecord;
  cumulativeRefundedAmount: bigint;
  refundEvidenceHash: Hex;
  config: StandardRailConfig;
  chainId: number;
}) {
  if (!args.order.authorizationKey || args.cumulativeRefundedAmount <= 0n ||
    args.cumulativeRefundedAmount > BigInt(args.order.grossAmount)) {
    throw new Error("Reputation refund facts are invalid");
  }
  const permit = {
    orderKey: args.order.orderKey,
    authorizationKey: args.order.authorizationKey,
    cumulativeRefundedAmount: args.cumulativeRefundedAmount,
    refundEvidenceHash: args.refundEvidenceHash,
    validBefore: BigInt(Math.floor(Date.now() / 1_000) + args.config.reputationPermitTtlSeconds),
  };
  const signature = await privateKeyToAccount(args.config.reputationOrderPrivateKey).signTypedData({
    domain: { name: "Daski Reputation", version: "1", chainId: args.chainId,
      verifyingContract: args.config.reputationContract },
    primaryType: "StandardReputationRefundV1",
    types: refundTypes,
    message: permit,
  });
  const canonicalIntent = {
    operation: "record-refund" as const,
    permit: { ...permit, cumulativeRefundedAmount: permit.cumulativeRefundedAmount.toString(),
      validBefore: permit.validBefore.toString() },
    signature,
  };
  return { canonicalIntent, intentHash: canonicalHash(canonicalIntent) };
}
