import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";

export const BAZAAR_RUNTIME_MANIFEST_LOCK_KEY =
  "daski-gateway:bazaar-runtime-manifest";

interface RawRuntimeManifest {
  manifest_epoch: string;
  manifest_hash: Buffer;
  approval_authority: Buffer | null;
  deployment_id: Buffer | null;
}

interface RawAdmissionManifest extends RawRuntimeManifest {
  admitting: boolean;
}

type ManifestActionResult<T> =
  { active: false } | { active: true; value: T };

export async function isBazaarRuntimeManifestActive(
  pool: Pool,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): Promise<boolean> {
  const active = await pool.query<RawAdmissionManifest>(admissionQuery());
  return matchesIdentity(active.rows, identity) && active.rows[0]!.admitting;
}

export async function lockBazaarRuntimeManifestForAdmission(
  client: PoolClient,
  identity: ApprovedBazaarRuntimeManifestIdentity,
): Promise<boolean> {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    [BAZAAR_RUNTIME_MANIFEST_LOCK_KEY],
  );
  const active = await client.query<RawAdmissionManifest>(
    `${admissionQuery()} FOR SHARE OF m`,
  );
  return matchesIdentity(active.rows, identity) && active.rows[0]!.admitting;
}

export async function lockCurrentBazaarRuntimeManifest(
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
}): Promise<ManifestActionResult<T>> {
  return withMatchingBazaarRuntimeManifest(input, true);
}

export async function withCurrentBazaarRuntimeManifest<T>(input: {
  pool: Pool;
  identity: ApprovedBazaarRuntimeManifestIdentity;
  action: (client: PoolClient) => Promise<T>;
}): Promise<ManifestActionResult<T>> {
  return withMatchingBazaarRuntimeManifest(input, false);
}

async function withMatchingBazaarRuntimeManifest<T>(input: {
  pool: Pool;
  identity: ApprovedBazaarRuntimeManifestIdentity;
  action: (client: PoolClient) => Promise<T>;
}, requireAdmission: boolean): Promise<ManifestActionResult<T>> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const matches = requireAdmission
      ? await lockBazaarRuntimeManifestForAdmission(client, input.identity)
      : await lockCurrentBazaarRuntimeManifest(client, input.identity);
    if (!matches) {
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

function admissionQuery(): string {
  return `SELECT m.manifest_epoch, m.manifest_hash, m.approval_authority,
                 m.deployment_id, NOT EXISTS (
                   SELECT 1 FROM bazaar_runtime_transition_intents i
                    WHERE i.state = 'draining'
                      AND i.source_epoch = m.manifest_epoch
                      AND i.source_hash = m.manifest_hash
                 ) AS admitting
            FROM bazaar_runtime_manifests m
           WHERE m.retired_at IS NULL`;
}

function matchesIdentity(
  rows: RawRuntimeManifest[],
  identity: ApprovedBazaarRuntimeManifestIdentity,
): boolean {
  return rows.length === 1 &&
    BigInt(rows[0]!.manifest_epoch) === identity.epoch &&
    rows[0]!.manifest_hash.equals(hexToBytea(identity.hash)) &&
    rows[0]!.approval_authority?.equals(
      hexToBytea(identity.approvalAuthority),
    ) === true &&
    rows[0]!.deployment_id?.equals(hexToBytea(identity.deploymentId)) === true;
}
