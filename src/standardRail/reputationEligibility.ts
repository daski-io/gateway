import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StandardRailConfig } from "./config.js";
import type { StandardListing } from "./types.js";

export function isReputationEligiblePayer(
  payer: string,
  listing: StandardListing,
  config: StandardRailConfig,
): boolean {
  const privateKeys = [
    config.quotePrivateKey,
    config.dispatchPrivateKey,
    config.receiptPrivateKey,
    config.lifecyclePrivateKey,
    config.releasePrivateKey,
    config.reputationOrderPrivateKey,
    config.reputationRelayerPrivateKey,
  ];
  const controlled = new Set([
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.manifest.payload.splitterAddress,
    listing.providerOwner,
    listing.providerAgentWallet,
    ...listing.screeningPolicy.providerControlledWallets,
    ...privateKeys.map((key) => privateKeyToAccount(key).address),
  ].map((address) => getAddress(address).toLowerCase()));
  return !controlled.has(getAddress(payer).toLowerCase());
}
