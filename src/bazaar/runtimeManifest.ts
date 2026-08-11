import { keccak256, toBytes, type Hex } from "viem";
import { canonicalJsonStringify } from "../auth/envelope.js";
import { listingOfferHash } from "./offer.js";
import { computeBazaarRefundPolicyVersion } from "./refundPolicy.js";
import type {
  BazaarChallengeMacKey,
  BazaarCompatibilityWiring,
  BazaarListing,
} from "./types.js";

export interface BazaarRuntimeManifestIdentity {
  epoch: bigint;
  hash: Hex;
}

export function computeBazaarRuntimeManifestIdentity(
  wiring: BazaarCompatibilityWiring,
  lifecycleDomainRetentionSeconds: number,
): BazaarRuntimeManifestIdentity {
  const body = {
    version: "DaskiBazaarRuntimeManifestV1",
    epoch: wiring.runtimeManifestEpoch.toString(),
    publicOrigin: wiring.publicOrigin,
    approvedTermsOrigins: [...wiring.approvedTermsOrigins].sort(),
    activeListings: listingIdentities(wiring.listings),
    recoveryListings: listingIdentities(wiring.recoveryListings),
    retiredLifecycleCommitments: wiring.retiredLifecycleCommitments
      .map((value) => value.toLowerCase())
      .sort(),
    adapterCallTimeoutMs: wiring.adapterCallTimeoutMs,
    lifecycleDomainRetentionSeconds,
    settlementCapacity: { ...wiring.settlementCapacity },
    settlementObservationPolicy: { ...wiring.settlementObservationPolicy },
    fulfillmentObservationPolicy: { ...wiring.fulfillmentObservationPolicy },
    refundWorkerPolicy: { ...wiring.refundWorkerPolicy },
    refundRiskPolicies: Object.entries(wiring.refundRiskPolicies)
      .sort(([left], [right]) => compareText(left, right))
      .map(([providerAgentId, policy]) => ({
        providerAgentId,
        policyVersion: computeBazaarRefundPolicyVersion(
          BigInt(providerAgentId),
          policy,
        ).toLowerCase(),
      })),
    providerActionSigner: wiring.providerActionSigningBroker.address.toLowerCase(),
    refundInstructionSigner:
      wiring.refundInstructionSigningBroker.address.toLowerCase(),
    challengeMac: {
      current: challengeKeyIdentity(wiring.challengeMac.current),
      retained: (wiring.challengeMac.retained ?? [])
        .map((key) => ({
          ...challengeKeyIdentity(key),
          acceptUntil: key.acceptUntil.toString(),
        }))
        .sort((left, right) => compareText(left.epoch, right.epoch)),
    },
  };
  return {
    epoch: wiring.runtimeManifestEpoch,
    hash: keccak256(toBytes(canonicalJsonStringify(body))),
  };
}

function listingIdentities(listings: BazaarListing[]) {
  return listings.map((listing) => ({
    listingCommitment: listing.listingCommitment.toLowerCase(),
    routePath: listing.routePath,
    offerHash: listingOfferHash(listing.offer.message).toLowerCase(),
    offerSignatureHash: keccak256(listing.offer.signature).toLowerCase(),
    payToControlProofHash: keccak256(
      listing.payToControlProof.signature,
    ).toLowerCase(),
    fulfillmentSignerControlProofHash: keccak256(
      listing.fulfillmentSignerControlProof.signature,
    ).toLowerCase(),
    termsDocumentHash: listing.termsDocumentHash.toLowerCase(),
  })).sort((left, right) =>
    compareText(left.listingCommitment, right.listingCommitment));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function challengeKeyIdentity(key: BazaarChallengeMacKey) {
  return {
    epoch: key.epoch,
    secretCommitment: keccak256(key.secret).toLowerCase(),
  };
}
