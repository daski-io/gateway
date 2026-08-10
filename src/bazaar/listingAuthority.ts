import type { ProviderAuthorityService } from "../payment/providerAuthority.js";
import { validateCompatibilityListing } from "./offer.js";
import type { BazaarListing } from "./types.js";

export async function requireCurrentListing(
  listing: BazaarListing,
  providerAuthority: ProviderAuthorityService,
  nowSeconds: bigint,
  forceAuthorityRefresh = false,
  minimumRemainingSeconds = 0n,
): Promise<void> {
  await validateCompatibilityListing(listing, nowSeconds);
  if (listing.offer.message.validBefore - nowSeconds <= minimumRemainingSeconds) {
    throw new Error("Bazaar listing offer is too close to expiry");
  }
  const authority = forceAuthorityRefresh
    ? await providerAuthority.requireCurrent(listing.offer.message.providerAgentId)
    : await providerAuthority.requireFresh(listing.offer.message.providerAgentId);
  const wallet = authority.walletAddress.toLowerCase();
  const offer = listing.offer.message;
  if (wallet !== offer.offerSigner.toLowerCase()) {
    throw new Error("Bazaar listing provider authority changed");
  }
}
