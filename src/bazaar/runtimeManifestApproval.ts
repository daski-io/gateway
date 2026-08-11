import {
  hashTypedData,
  parseSignature,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import type { BazaarRuntimeManifestIdentity } from "./runtimeManifest.js";
import type {
  BazaarCompatibilityWiring,
  BazaarRuntimeManifestApproval,
  BazaarRuntimeManifestTrust,
} from "./types.js";

const HALF_SECP256K1_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MAX_APPROVAL_LIFETIME_SECONDS = 24n * 60n * 60n;
const MAX_UINT256 = (1n << 256n) - 1n;

export const BAZAAR_RUNTIME_MANIFEST_APPROVAL_TYPES = {
  DaskiBazaarRuntimeManifestApproval: [
    { name: "deploymentId", type: "bytes32" },
    { name: "manifestEpoch", type: "uint256" },
    { name: "manifestHash", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

export interface ApprovedBazaarRuntimeManifestIdentity
  extends BazaarRuntimeManifestIdentity {
  approvalAuthority: Hex;
  deploymentId: Hex;
}

export function bazaarRuntimeManifestApprovalTypedData(input: {
  identity: BazaarRuntimeManifestIdentity;
  approval: BazaarRuntimeManifestApproval;
  trust: BazaarRuntimeManifestTrust;
}) {
  return {
    domain: {
      name: "Daski Bazaar Runtime Manifest Approval",
      version: "1",
      chainId: input.trust.chainId,
    },
    types: BAZAAR_RUNTIME_MANIFEST_APPROVAL_TYPES,
    primaryType: "DaskiBazaarRuntimeManifestApproval" as const,
    message: {
      deploymentId: input.trust.deploymentId,
      manifestEpoch: input.identity.epoch,
      manifestHash: input.identity.hash,
      issuedAt: input.approval.issuedAt,
      validBefore: input.approval.validBefore,
    },
  };
}

export async function validateBazaarRuntimeManifestApproval(input: {
  identity: BazaarRuntimeManifestIdentity;
  approval: BazaarRuntimeManifestApproval;
  trust: BazaarRuntimeManifestTrust;
  wiring: BazaarCompatibilityWiring;
  now: bigint;
}): Promise<ApprovedBazaarRuntimeManifestIdentity> {
  const identity = { ...input.identity };
  const approval = { ...input.approval };
  const trust = { ...input.trust };
  validateTrust(trust, input.wiring);
  if (
    typeof approval.issuedAt !== "bigint" || approval.issuedAt < 0n ||
    typeof approval.validBefore !== "bigint" ||
    approval.validBefore > MAX_UINT256 ||
    approval.issuedAt > input.now || approval.validBefore <= input.now ||
    approval.validBefore - approval.issuedAt > MAX_APPROVAL_LIFETIME_SECONDS ||
    !/^0x[0-9a-fA-F]{130}$/.test(approval.signature)
  ) throw new Error("Bazaar runtime manifest approval is malformed or stale");
  if (BigInt(parseSignature(approval.signature).s) > HALF_SECP256K1_N) {
    throw new Error("Bazaar runtime manifest approval is not canonical low-s");
  }
  const signer = await recoverTypedDataAddress({
    ...bazaarRuntimeManifestApprovalTypedData({ identity, approval, trust }),
    signature: approval.signature,
  });
  if (signer.toLowerCase() !== trust.authority.toLowerCase()) {
    throw new Error("Bazaar runtime manifest approval authority is invalid");
  }
  return {
    ...identity,
    approvalAuthority: trust.authority.toLowerCase() as Hex,
    deploymentId: trust.deploymentId.toLowerCase() as Hex,
  };
}

export function bazaarRuntimeManifestApprovalDigest(input: {
  identity: BazaarRuntimeManifestIdentity;
  approval: BazaarRuntimeManifestApproval;
  trust: BazaarRuntimeManifestTrust;
}): Hex {
  return hashTypedData(bazaarRuntimeManifestApprovalTypedData(input));
}

function validateTrust(
  trust: BazaarRuntimeManifestTrust,
  wiring: BazaarCompatibilityWiring,
): void {
  if (
    !isHexAddress(trust.authority) ||
    trust.authority.toLowerCase() === `0x${"00".repeat(20)}` ||
    !isHex32(trust.deploymentId) ||
    trust.deploymentId.toLowerCase() === `0x${"00".repeat(32)}` ||
    typeof trust.chainId !== "bigint" || trust.chainId !== 84532n ||
    trust.chainId > MAX_UINT256
  ) throw new Error("Bazaar runtime manifest trust root is invalid");
  const authority = trust.authority.toLowerCase();
  const conflictingAddresses = [
    wiring.providerActionSigningBroker.address,
    wiring.refundInstructionSigningBroker.address,
    ...Object.values(wiring.refundRiskPolicies).map((policy) => policy.refundWallet),
    ...[...wiring.listings, ...wiring.recoveryListings].flatMap((listing) => [
      listing.offer.message.offerSigner,
      listing.offer.message.fulfillmentSigner,
      listing.offer.message.payTo,
      listing.offer.message.token,
    ]),
  ];
  if (conflictingAddresses.some((address) => address.toLowerCase() === authority)) {
    throw new Error("Bazaar runtime manifest authority must be purpose-separated");
  }
}
