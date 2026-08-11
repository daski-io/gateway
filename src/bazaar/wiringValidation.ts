import { isHexAddress } from "../util/evmValidation.js";
import { validateBazaarAdapterCallTimeout } from "./adapterCall.js";
import {
  validateFulfillmentObservationPolicy,
  validateFulfillmentSignerRoles,
} from "./fulfillmentPolicy.js";
import { validateChallengeMacKeyring } from "./lifecycleChallenge.js";
import {
  validateCompatibilityListing,
  validateCompatibilityRecoveryListing,
} from "./offer.js";
import {
  validateRefundRiskPolicies,
  validateRefundWorkerPolicy,
} from "./refundPolicy.js";
import { validateSettlementCapacityPolicy } from "./settlementCapacity.js";
import { validateSettlementObservationPolicy } from "./settlementObservation.js";
import type { BazaarCompatibilityWiring, BazaarListing } from "./types.js";

export async function validateBazaarCompatibilityWiring(
  wiring: BazaarCompatibilityWiring,
): Promise<void> {
  const now = BigInt(Math.floor((wiring.now?.() ?? new Date()).getTime() / 1_000));
  validatePolicies(wiring, now);
  const publicOrigin = validatePublicOrigin(wiring.publicOrigin);
  const termsOrigins = validateApprovedTermsOrigins(wiring.approvedTermsOrigins);
  const retired = validateRetiredCommitments(wiring.retiredLifecycleCommitments);
  const allListings = [...wiring.listings, ...wiring.recoveryListings];
  validateSigningRoles(wiring, allListings);
  await validateListings({ wiring, allListings, retired, publicOrigin, termsOrigins, now });
}

function validatePolicies(wiring: BazaarCompatibilityWiring, now: bigint): void {
  validateChallengeMacKeyring(wiring.challengeMac, now);
  validateBazaarAdapterCallTimeout(wiring.adapterCallTimeoutMs);
  validateSettlementCapacityPolicy(wiring.settlementCapacity);
  validateSettlementObservationPolicy(wiring.settlementObservationPolicy);
  validateFulfillmentObservationPolicy(wiring.fulfillmentObservationPolicy);
  validateRefundRiskPolicies(wiring.refundRiskPolicies, wiring.listings);
  validateRefundWorkerPolicy(wiring.refundWorkerPolicy);
  if (
    wiring.refundWorkerPolicy.instructionTtlSeconds <=
      Math.ceil(wiring.adapterCallTimeoutMs / 1_000) * 2 + 5
  ) throw new Error("Bazaar refund instruction TTL cannot cover adapter deadlines");
}

function validateRetiredCommitments(values: string[]): Set<string> {
  const retired = new Set<string>();
  for (const value of values) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error("Bazaar retired lifecycle commitment is malformed");
    }
    const normalized = value.toLowerCase();
    if (retired.has(normalized)) {
      throw new Error("Bazaar retired lifecycle commitments must be unique");
    }
    retired.add(normalized);
  }
  return retired;
}

function validateSigningRoles(
  wiring: BazaarCompatibilityWiring,
  listings: BazaarListing[],
): void {
  const providerActionSigner = wiring.providerActionSigningBroker.address.toLowerCase();
  const refundSigner = wiring.refundInstructionSigningBroker.address.toLowerCase();
  const refundWallets = Object.values(wiring.refundRiskPolicies).map(
    (policy) => policy.refundWallet.toLowerCase(),
  );
  if (
    !isHexAddress(wiring.providerActionSigningBroker.address) ||
    /^0x0{40}$/.test(providerActionSigner) ||
    refundWallets.includes(providerActionSigner)
  ) throw new Error("Bazaar provider-action signer must be valid and purpose-separated");
  if (
    !isHexAddress(wiring.refundInstructionSigningBroker.address) ||
    /^0x0{40}$/.test(refundSigner) || refundSigner === providerActionSigner ||
    refundWallets.includes(refundSigner)
  ) throw new Error("Bazaar refund signer must be valid and purpose-separated");
  for (const listing of listings) {
    const offer = listing.offer.message;
    if (
      providerActionSigner === offer.offerSigner.toLowerCase() ||
      providerActionSigner === offer.payTo.toLowerCase()
    ) throw new Error("Bazaar lifecycle keys cannot reuse listing or payment keys");
    if (
      refundSigner === offer.offerSigner.toLowerCase() ||
      refundSigner === offer.payTo.toLowerCase()
    ) throw new Error("Bazaar refund keys cannot reuse listing or payment keys");
    validateFulfillmentSignerRoles({
      offer,
      providerActionSigner,
      refundSigner,
      refundRiskPolicies: wiring.refundRiskPolicies,
      listings,
    });
  }
}

async function validateListings(input: {
  wiring: BazaarCompatibilityWiring;
  allListings: BazaarListing[];
  retired: Set<string>;
  publicOrigin: string;
  termsOrigins: Set<string>;
  now: bigint;
}): Promise<void> {
  const active = new Set(input.wiring.listings);
  const routes = new Set<string>();
  const recipients = new Set<string>();
  const commitments = new Set<string>();
  const offerIds = new Map<string, string>();
  for (const listing of input.allListings) {
    const isActive = active.has(listing);
    await (isActive
      ? validateCompatibilityListing(listing, input.now)
      : validateCompatibilityRecoveryListing(listing, input.now));
    validateListingOrigins(listing, input.publicOrigin, input.termsOrigins);
    const offer = listing.offer.message;
    if (offer.chainId !== 84532n) {
      throw new Error("Bazaar compatibility harness is Base Sepolia only");
    }
    const commitment = offer.listingCommitment.toLowerCase();
    if (isActive === input.retired.has(commitment)) {
      throw new Error("Bazaar active and recovery listing states are inconsistent");
    }
    const recipient = offer.payTo.toLowerCase();
    if (
      recipients.has(recipient) || commitments.has(commitment) ||
      (isActive && routes.has(listing.routePath))
    ) throw new Error("Bazaar listings must have unique routes, payTo values, and commitments");
    if (isActive) routes.add(listing.routePath);
    recipients.add(recipient);
    commitments.add(commitment);
    validateOfferIdentity(offerIds, listing);
  }
}

function validateListingOrigins(
  listing: BazaarListing,
  publicOrigin: string,
  termsOrigins: Set<string>,
): void {
  if (new URL(listing.resourceUrl).origin !== publicOrigin) {
    throw new Error("Bazaar resource URL does not use the canonical public origin");
  }
  if (!termsOrigins.has(new URL(listing.termsUrl).origin)) {
    throw new Error("Bazaar terms URL does not use an approved publication origin");
  }
}

function validateOfferIdentity(offerIds: Map<string, string>, listing: BazaarListing): void {
  const offer = listing.offer.message;
  const offerId = offer.offerId.toLowerCase();
  const offerHash = JSON.stringify(offer, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value);
  const prior = offerIds.get(offerId);
  if (prior !== undefined && prior !== offerHash) {
    throw new Error("one Bazaar offerId cannot identify two offer bodies");
  }
  offerIds.set(offerId, offerHash);
}

function validatePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Bazaar public origin is invalid");
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || url.pathname !== "/" || value !== url.origin
  ) throw new Error("Bazaar public origin is invalid");
  return url.origin;
}

function validateApprovedTermsOrigins(origins: string[]): Set<string> {
  const approved = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Bazaar approved terms origin is invalid");
    }
    if (
      url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || url.pathname !== "/" || value !== url.origin || approved.has(value)
    ) throw new Error("Bazaar approved terms origin is invalid");
    approved.add(value);
  }
  if (approved.size === 0) throw new Error("Bazaar has no approved terms origin");
  return approved;
}
