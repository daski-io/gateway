import type { Hex } from "../types.js";
import { isHex32, isHexAddress } from "../util/evmValidation.js";
import type { BazaarListing } from "./types.js";

export function validateLifecycleDomainInput(input: {
  listings: BazaarListing[];
  retiredCommitments: Hex[];
  providerActionSigner: Hex;
  refundInstructionSigner: Hex;
  providerRefundWallets: Hex[];
  retentionSeconds: number;
}): void {
  if (!Number.isSafeInteger(input.retentionSeconds) || input.retentionSeconds < 1) {
    throw new Error("Bazaar lifecycle-domain retention must be a positive integer");
  }
  if (
    !isHexAddress(input.providerActionSigner) ||
    !isHexAddress(input.refundInstructionSigner) ||
    !input.providerRefundWallets.every(isHexAddress)
  ) {
    throw new Error("Bazaar lifecycle-domain signer is malformed");
  }
  const activeCommitments = new Set(
    input.listings.map((listing) =>
      listing.offer.message.listingCommitment.toLowerCase()),
  );
  const retiredCommitments = new Set<string>();
  for (const commitment of input.retiredCommitments) {
    const normalized = commitment.toLowerCase();
    if (
      !isHex32(commitment) || activeCommitments.has(normalized) ||
      retiredCommitments.has(normalized)
    ) throw new Error("Bazaar lifecycle-domain retirement set is invalid");
    retiredCommitments.add(normalized);
  }
}
