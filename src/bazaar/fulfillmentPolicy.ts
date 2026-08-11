import type {
  BazaarFulfillmentObservationPolicy,
  BazaarRefundRiskPolicy,
  ListingOfferV1,
} from "./types.js";

export function validateFulfillmentObservationPolicy(
  policy: BazaarFulfillmentObservationPolicy,
): void {
  if (
    !policy || typeof policy !== "object" || Array.isArray(policy) ||
    !Number.isSafeInteger(policy.retryDelaySeconds) ||
    policy.retryDelaySeconds < 5 ||
    policy.retryDelaySeconds > 3_600
  ) {
    throw new Error("Bazaar fulfillment observation policy is invalid");
  }
}

export function validateFulfillmentSignerRoles(input: {
  offer: ListingOfferV1;
  providerActionSigner: string;
  refundSigner: string;
  refundRiskPolicies: Record<string, BazaarRefundRiskPolicy>;
  listings: { offer: { message: ListingOfferV1 } }[];
}): void {
  const signer = input.offer.fulfillmentSigner.toLowerCase();
  if (signer === input.providerActionSigner) {
    throw new Error("Bazaar lifecycle keys cannot reuse listing or payment keys");
  }
  if (signer === input.refundSigner) {
    throw new Error("Bazaar refund keys cannot reuse listing or payment keys");
  }
  if (
    signer === `0x${"00".repeat(20)}` ||
    input.listings.some((listing) => [
      listing.offer.message.offerSigner,
      listing.offer.message.payTo,
      listing.offer.message.token,
    ].some((address) => address.toLowerCase() === signer)) ||
    Object.values(input.refundRiskPolicies).some((policy) =>
      policy.refundWallet.toLowerCase() === signer)
  ) throw new Error("Bazaar fulfillment signer must be purpose-separated");
}
