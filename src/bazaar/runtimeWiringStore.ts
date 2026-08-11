import type { Pool } from "../db/pool.js";
import {
  lockLifecycleDomainRegistry,
  reconcileLifecycleDomainsInTransaction,
} from "./lifecycleDomainRegistry.js";
import { reconcileListingRuntimeBindingsInTransaction } from "./listingStore.js";
import { bindBazaarKeyRole } from "./keyRoleStore.js";
import { reconcileChallengeMacEpochsInTransaction } from
  "./challengeMacEpochStore.js";
import {
  computeBazaarRuntimeManifestIdentity,
} from "./runtimeManifest.js";
import {
  bazaarRuntimeManifestApprovalDigest,
  type ApprovedBazaarRuntimeManifestIdentity,
  validateBazaarRuntimeManifestApproval,
} from "./runtimeManifestApproval.js";
import { transitionBazaarRuntimeManifest } from "./runtimeManifestStore.js";
import { bazaarNowSeconds } from "./runtimeTime.js";
import type {
  BazaarCompatibilityWiring,
  BazaarRuntimeManifestTrust,
} from "./types.js";

export async function activateBazaarRuntimeWiring(input: {
  pool: Pool;
  wiring: BazaarCompatibilityWiring;
  trust: BazaarRuntimeManifestTrust;
  lifecycleDomainRetentionSeconds: number;
}): Promise<ApprovedBazaarRuntimeManifestIdentity> {
  const trust = { ...input.trust };
  const now = bazaarNowSeconds();
  const unsignedIdentity = computeBazaarRuntimeManifestIdentity(
    input.wiring,
    input.lifecycleDomainRetentionSeconds,
  );
  const identity = await validateBazaarRuntimeManifestApproval({
    identity: unsignedIdentity,
    approval: input.wiring.runtimeManifestApproval,
    trust,
    wiring: input.wiring,
    now,
  });
  const approvalDigest = bazaarRuntimeManifestApprovalDigest({
    identity,
    approval: input.wiring.runtimeManifestApproval,
    trust,
  });
  await transitionBazaarRuntimeManifest(
    input.pool,
    identity,
    input.wiring.runtimeManifestApproval,
    approvalDigest,
    async (client) => {
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
      await bindBazaarKeyRole(
        client,
        identity.approvalAuthority,
        "daski_manifest",
      );
      await reconcileChallengeMacEpochsInTransaction({
        client,
        keyring: input.wiring.challengeMac,
        now,
      });
      await reconcileLifecycleDomainsInTransaction(client, lifecycleInput);
    },
  );
  return identity;
}
