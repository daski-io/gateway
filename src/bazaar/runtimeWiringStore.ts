import type { Pool } from "../db/pool.js";
import {
  lockLifecycleDomainRegistry,
  reconcileLifecycleDomainsInTransaction,
} from "./lifecycleDomainRegistry.js";
import { reconcileListingRuntimeBindingsInTransaction } from "./listingStore.js";
import {
  computeBazaarRuntimeManifestIdentity,
  type BazaarRuntimeManifestIdentity,
} from "./runtimeManifest.js";
import { transitionBazaarRuntimeManifest } from "./runtimeManifestStore.js";
import type { BazaarCompatibilityWiring } from "./types.js";

export async function activateBazaarRuntimeWiring(input: {
  pool: Pool;
  wiring: BazaarCompatibilityWiring;
  lifecycleDomainRetentionSeconds: number;
}): Promise<BazaarRuntimeManifestIdentity> {
  const identity = computeBazaarRuntimeManifestIdentity(
    input.wiring,
    input.lifecycleDomainRetentionSeconds,
  );
  await transitionBazaarRuntimeManifest(input.pool, identity, async (client) => {
    const lifecycleInput = {
      listings: input.wiring.listings,
      retiredCommitments: input.wiring.retiredLifecycleCommitments,
      providerActionSigner: input.wiring.providerActionSigningBroker.address,
      refundInstructionSigner: input.wiring.refundInstructionSigningBroker.address,
      providerRefundWallets: Object.values(input.wiring.refundRiskPolicies).map(
        (policy) => policy.refundWallet,
      ),
      retentionSeconds: input.lifecycleDomainRetentionSeconds,
    };
    await lockLifecycleDomainRegistry(client);
    await reconcileListingRuntimeBindingsInTransaction(client, {
      activeListings: input.wiring.listings,
      recoveryListings: input.wiring.recoveryListings,
    });
    await reconcileLifecycleDomainsInTransaction(client, lifecycleInput);
  });
  return identity;
}
