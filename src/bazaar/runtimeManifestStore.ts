import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";
import type { BazaarRuntimeManifestApproval } from "./types.js";

interface RawRuntimeManifest {
  manifest_epoch: string;
  manifest_hash: Buffer;
  approval_authority: Buffer | null;
  deployment_id: Buffer | null;
}

export async function transitionBazaarRuntimeManifest(
  pool: Pool,
  identity: ApprovedBazaarRuntimeManifestIdentity,
  approval: BazaarRuntimeManifestApproval,
  approvalDigest: Hex,
  reconcile: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["daski-gateway:bazaar-runtime-manifest"],
    );
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
    if (!current || identity.epoch > BigInt(current.manifest_epoch)) {
      await assertNoLiveBazaarWork(client);
    }
    await reconcile(client);
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
      }
    }
    await recordApproval(client, identity, approval, approvalDigest);
    await client.query("COMMIT");
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

export async function isBazaarRuntimeManifestActive(
  pool: Pool,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): Promise<boolean> {
  const active = await pool.query<RawRuntimeManifest>(
    `SELECT manifest_epoch, manifest_hash, approval_authority, deployment_id
       FROM bazaar_runtime_manifests
      WHERE retired_at IS NULL`,
  );
  return matchesIdentity(active.rows, identity);
}

export async function lockBazaarRuntimeManifestForAdmission(
  client: PoolClient,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): Promise<boolean> {
  const active = await client.query<RawRuntimeManifest>(
    `SELECT manifest_epoch, manifest_hash, approval_authority, deployment_id
       FROM bazaar_runtime_manifests
      WHERE retired_at IS NULL FOR SHARE`,
  );
  return matchesIdentity(active.rows, identity);
}

export async function withActiveBazaarRuntimeManifest<T>(input: {
  pool: Pool;
  identity: ApprovedBazaarRuntimeManifestIdentity;
  action: (client: PoolClient) => Promise<T>;
}): Promise<{ active: false } | { active: true; value: T }> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockBazaarRuntimeManifestForAdmission(client, input.identity))) {
      await client.query("COMMIT");
      return { active: false };
    }
    const value = await input.action(client);
    await client.query("COMMIT");
    return { active: true, value };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
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

function matchesIdentity(
  rows: RawRuntimeManifest[],
  identity: ApprovedBazaarRuntimeManifestIdentity,
): boolean {
  return rows.length === 1 &&
    BigInt(rows[0]!.manifest_epoch) === identity.epoch &&
    rows[0]!.manifest_hash.equals(hexToBytea(identity.hash)) &&
    rows[0]!.approval_authority?.equals(hexToBytea(identity.approvalAuthority)) === true &&
    rows[0]!.deployment_id?.equals(hexToBytea(identity.deploymentId)) === true;
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

async function assertNoLiveBazaarWork(client: PoolClient): Promise<void> {
  await client.query(
    "DELETE FROM bazaar_runtime_executions WHERE lease_expires_at <= now()",
  );
  const live = await client.query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM bazaar_orders WHERE processing_lease_expires_at > now()
       UNION ALL
       SELECT 1 FROM bazaar_settlement_observations WHERE lease_expires_at > now()
       UNION ALL
       SELECT 1 FROM bazaar_refund_jobs WHERE lease_expires_at > now()
       UNION ALL
       SELECT 1 FROM bazaar_fulfillment_jobs WHERE lease_expires_at > now()
       UNION ALL
       SELECT 1 FROM bazaar_runtime_executions WHERE lease_expires_at > now()
     )`,
  );
  if (live.rowCount === 1) {
    throw new Error("Bazaar runtime manifest transition is blocked by live work");
  }
}
