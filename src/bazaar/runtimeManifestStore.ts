import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { BazaarRuntimeManifestIdentity } from "./runtimeManifest.js";
import {
  bazaarRuntimeManifestApprovalDigest,
  type ApprovedBazaarRuntimeManifestIdentity,
  validateBazaarRuntimeManifestApproval,
} from "./runtimeManifestApproval.js";
import {
  completeBazaarRuntimeDrain,
  establishBazaarRuntimeDrain,
  hasBazaarRuntimeDrain,
  hasLiveBazaarWork,
} from "./runtimeManifestDrainStore.js";
import { BAZAAR_RUNTIME_MANIFEST_LOCK_KEY } from
  "./runtimeManifestAccess.js";
import { bazaarNowSeconds } from "./runtimeTime.js";
import type {
  BazaarCompatibilityWiring,
  BazaarRuntimeManifestApproval,
  BazaarRuntimeManifestTrust,
} from "./types.js";

interface RawRuntimeManifest {
  manifest_epoch: string;
  manifest_hash: Buffer;
  approval_authority: Buffer | null;
  deployment_id: Buffer | null;
}

export type BazaarRuntimeTransitionResult = "active" | "draining";
export {
  isBazaarRuntimeManifestActive,
  lockBazaarRuntimeManifestForAdmission,
  lockCurrentBazaarRuntimeManifest,
  withActiveBazaarRuntimeManifest,
  withCurrentBazaarRuntimeManifest,
} from "./runtimeManifestAccess.js";

export async function transitionBazaarRuntimeManifest(input: {
  pool: Pool;
  identity: BazaarRuntimeManifestIdentity;
  approval: BazaarRuntimeManifestApproval;
  trust: BazaarRuntimeManifestTrust;
  wiring: BazaarCompatibilityWiring;
  reconcile: (
    client: PoolClient,
    identity: ApprovedBazaarRuntimeManifestIdentity,
  ) => Promise<void>;
}): Promise<{
  state: BazaarRuntimeTransitionResult;
  identity: ApprovedBazaarRuntimeManifestIdentity;
}> {
  const approval = { ...input.approval };
  const trust = { ...input.trust };
  const unsignedIdentity = { ...input.identity };
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [BAZAAR_RUNTIME_MANIFEST_LOCK_KEY],
    );
    const identity = await validateBazaarRuntimeManifestApproval({
      identity: unsignedIdentity,
      approval,
      trust,
      wiring: input.wiring,
      now: bazaarNowSeconds(),
    });
    const approvalDigest = bazaarRuntimeManifestApprovalDigest({
      identity: unsignedIdentity,
      approval,
      trust,
    });
    const active = await client.query<RawRuntimeManifest>(
      `SELECT manifest_epoch, manifest_hash, approval_authority, deployment_id
         FROM bazaar_runtime_manifests
        WHERE retired_at IS NULL FOR UPDATE`,
    );
    if (active.rows.length > 1) {
      throw new Error("Bazaar runtime manifest active-row invariant violated");
    }
    const current = active.rows[0];
    assertPermittedTransition(current, identity);
    if (current) {
      const currentEpoch = BigInt(current.manifest_epoch);
      if (identity.epoch === currentEpoch && await hasBazaarRuntimeDrain(client)) {
        await client.query("COMMIT");
        return { state: "draining", identity };
      }
      if (identity.epoch > currentEpoch) {
        const liveWork = await hasLiveBazaarWork(client);
        if (liveWork) {
          await preflightReconciliation(
            client,
            (candidate) => input.reconcile(candidate, identity),
          );
        }
        await establishBazaarRuntimeDrain({
          client, current, identity, approval, approvalDigest,
        });
        if (liveWork) {
          await client.query("COMMIT");
          return { state: "draining", identity };
        }
      }
    }
    await input.reconcile(client, identity);
    if (!current) {
      await insertManifest(client, identity);
    } else {
      const currentEpoch = BigInt(current.manifest_epoch);
      if (identity.epoch > currentEpoch) {
        await client.query(
          `UPDATE bazaar_runtime_manifests
              SET retired_at = GREATEST(now(), activated_at)
            WHERE manifest_epoch = $1 AND retired_at IS NULL`,
          [current.manifest_epoch],
        );
        await insertManifest(client, identity);
        await completeBazaarRuntimeDrain({ client, current, identity });
      }
    }
    await recordApproval(client, identity, approval, approvalDigest);
    await client.query("COMMIT");
    return { state: "active", identity };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function assertPermittedTransition(
  current: RawRuntimeManifest | undefined,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): void {
  if (!current) return;
  const currentEpoch = BigInt(current.manifest_epoch);
  if (
    !current.approval_authority?.equals(hexToBytea(identity.approvalAuthority)) ||
    !current.deployment_id?.equals(hexToBytea(identity.deploymentId))
  ) {
    throw new Error("Bazaar runtime manifest trust provenance changed");
  }
  if (identity.epoch < currentEpoch) {
    throw new Error("Bazaar runtime manifest epoch is stale");
  }
  if (
    identity.epoch === currentEpoch &&
    !current.manifest_hash.equals(hexToBytea(identity.hash))
  ) {
    throw new Error("Bazaar runtime manifest or provenance changed within one epoch");
  }
}

async function insertManifest(
  client: PoolClient,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): Promise<void> {
  await client.query(
    `INSERT INTO bazaar_runtime_manifests
       (manifest_epoch, manifest_hash, approval_authority, deployment_id)
     VALUES ($1, $2, $3, $4)`,
    [
      identity.epoch.toString(), hexToBytea(identity.hash),
      hexToBytea(identity.approvalAuthority), hexToBytea(identity.deploymentId),
    ],
  );
}

async function preflightReconciliation(
  client: PoolClient,
  reconcile: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await client.query("SAVEPOINT bazaar_runtime_reconciliation");
  await reconcile(client);
  await client.query("ROLLBACK TO SAVEPOINT bazaar_runtime_reconciliation");
}

async function recordApproval(
  client: PoolClient,
  identity: ApprovedBazaarRuntimeManifestIdentity,
  approval: BazaarRuntimeManifestApproval,
  approvalDigest: Hex,
): Promise<void> {
  await client.query(
    `INSERT INTO bazaar_runtime_manifest_approvals
       (manifest_epoch, approval_authority, deployment_id, approval_digest,
        approval_signature, issued_at, valid_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (manifest_epoch, approval_digest) DO NOTHING`,
    [
      identity.epoch.toString(), hexToBytea(identity.approvalAuthority),
      hexToBytea(identity.deploymentId), hexToBytea(approvalDigest),
      hexToBytea(approval.signature), approval.issuedAt.toString(),
      approval.validBefore.toString(),
    ],
  );
}
