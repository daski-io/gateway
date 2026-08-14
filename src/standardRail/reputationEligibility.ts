import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StandardRailConfig } from "./config.js";
import type { StandardListing } from "./types.js";

export function isReputationEligiblePayer(
  payer: string,
  listing: StandardListing,
  config: StandardRailConfig,
): boolean {
  const snapshot = config.manifest.providerIdentitySnapshots.find((item) =>
    item.payload.providerAgentId === listing.commitment.payload.providerAgentId &&
    item.payload.serviceId === listing.commitment.payload.serviceId);
  const privateKeys = [
    config.quotePrivateKey,
    config.dispatchPrivateKey,
    config.receiptPrivateKey,
    config.lifecyclePrivateKey,
    config.releasePrivateKey,
    config.refundPrivateKey,
    config.reputationOrderPrivateKey,
    config.reputationRelayerPrivateKey,
    config.mirror.privateKey,
    config.notification.privateKey,
  ];
  const controlled = new Set([
    listing.commitment.payload.providerAuthorityKey,
    listing.commitment.payload.providerTerminalAttestationKey,
    listing.commitment.payload.providerPayee,
    listing.commitment.payload.daskiCommissionReceiver,
    listing.manifest.payload.splitterAddress,
    listing.refundPolicy.executionReserveAddress,
    ...listing.screeningPolicy.providerControlledWallets,
    ...(snapshot ? [snapshot.payload.providerOwner, snapshot.payload.providerAgentWallet,
      snapshot.payload.providerPayee] : []),
    ...privateKeys.map((key) => privateKeyToAccount(key).address),
  ].map((address) => getAddress(address).toLowerCase()));
  return !controlled.has(getAddress(payer).toLowerCase());
}
