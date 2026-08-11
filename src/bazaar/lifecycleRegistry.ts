import type { Pool } from "../db/pool.js";
import { readLifecycleDomains } from "./lifecycleDomainRegistry.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";
import { withActiveBazaarRuntimeManifest } from "./runtimeManifestStore.js";
import { bazaarNowSeconds } from "./runtimeTime.js";
import type { BazaarCompatibilityWiring } from "./types.js";

export async function readBazaarLifecycleRegistry(input: {
  pool: Pool;
  runtimeManifest: ApprovedBazaarRuntimeManifestIdentity;
  wiring: BazaarCompatibilityWiring;
}) {
  const registry = await withActiveBazaarRuntimeManifest({
    pool: input.pool,
    identity: input.runtimeManifest,
    action: async (client) => {
      const now = bazaarNowSeconds();
      const retainedKeys = (input.wiring.challengeMac.retained ?? [])
        .filter((key) => key.acceptUntil > now)
        .map((key) => ({
          epoch: key.epoch,
          status: "retained",
          acceptUntil: key.acceptUntil.toString(),
        }));
      return {
        version: "1",
        providerActionSigner:
          input.wiring.providerActionSigningBroker.address,
        challengeMacKeys: [
          {
            epoch: input.wiring.challengeMac.current.epoch,
            status: "current",
          },
          ...retainedKeys,
        ],
        domains: await readLifecycleDomains(client),
      };
    },
  });
  return registry.active ? registry.value : null;
}
