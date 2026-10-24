import { getAddress } from "viem";
import type { StandardRailConfig } from "./config.js";
import type { StandardListing } from "./types.js";

export function isReputationEligiblePayer(
  payer: string,
  listing: StandardListing,
  config: StandardRailConfig,
): boolean {
  const controlled = new Set([
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.manifest.payload.splitterAddress,
    listing.providerOwner,
    listing.providerAgentWallet,
    ...listing.screeningPolicy.providerControlledWallets,
    // The gateway's own roles, and every manifest signer it trusts, retired
    // keys included: none of them may earn buyer reputation.
    config.signers.identity.address,
    config.signers.sender.address,
    ...(["gateway-protocol", "gateway-quote", "gateway-dispatch", "gateway-lifecycle", "gateway-receipt"] as const)
      .map((keyId) => config.signers.artifact(keyId).address),
    ...[...config.trustedSigners.values()].flat(),
  ].map((address) => getAddress(address).toLowerCase()));
  return !controlled.has(getAddress(payer).toLowerCase());
}
