import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { BazaarRuntimeManifestIdentity } from "./runtimeManifest.js";

interface RawRuntimeManifest {
  manifest_epoch: string;
  manifest_hash: Buffer;
}

export async function transitionBazaarRuntimeManifest(
  pool: Pool,
  identity: BazaarRuntimeManifestIdentity,
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
      `SELECT manifest_epoch, manifest_hash FROM bazaar_runtime_manifests
        WHERE retired_at IS NULL FOR UPDATE`,
    );
    if (active.rows.length > 1) {
      throw new Error("Bazaar runtime manifest active-row invariant violated");
    }
    const current = active.rows[0];
    assertPermittedTransition(current, identity);
    await reconcile(client);
    if (!current) {
      await insertManifest(client, identity);
    } else {
      const currentEpoch = BigInt(current.manifest_epoch);
      if (identity.epoch > currentEpoch) {
        await client.query(
          `UPDATE bazaar_runtime_manifests SET retired_at = now()
            WHERE manifest_epoch = $1 AND retired_at IS NULL`,
          [current.manifest_epoch],
        );
        await insertManifest(client, identity);
      }
    }
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
  identity: BazaarRuntimeManifestIdentity,
): void {
  if (!current) return;
  const currentEpoch = BigInt(current.manifest_epoch);
  if (identity.epoch < currentEpoch) {
    throw new Error("Bazaar runtime manifest epoch is stale");
  }
  if (
    identity.epoch === currentEpoch &&
    !current.manifest_hash.equals(hexToBytea(identity.hash))
  ) {
    throw new Error("Bazaar runtime manifest changed within one epoch");
  }
}

export async function isBazaarRuntimeManifestActive(
  pool: Pool,
  identity: BazaarRuntimeManifestIdentity,
): Promise<boolean> {
  const active = await pool.query<RawRuntimeManifest>(
    `SELECT manifest_epoch, manifest_hash FROM bazaar_runtime_manifests
      WHERE retired_at IS NULL`,
  );
  return matchesIdentity(active.rows, identity);
}

export async function lockBazaarRuntimeManifestForAdmission(
  client: PoolClient,
  identity: BazaarRuntimeManifestIdentity,
): Promise<boolean> {
  const active = await client.query<RawRuntimeManifest>(
    `SELECT manifest_epoch, manifest_hash FROM bazaar_runtime_manifests
      WHERE retired_at IS NULL FOR SHARE`,
  );
  return matchesIdentity(active.rows, identity);
}

async function insertManifest(
  client: PoolClient,
  identity: BazaarRuntimeManifestIdentity,
): Promise<void> {
  await client.query(
    `INSERT INTO bazaar_runtime_manifests (manifest_epoch, manifest_hash)
     VALUES ($1, $2)`,
    [identity.epoch.toString(), hexToBytea(identity.hash)],
  );
}

function matchesIdentity(
  rows: RawRuntimeManifest[],
  identity: BazaarRuntimeManifestIdentity,
): boolean {
  return rows.length === 1 &&
    BigInt(rows[0]!.manifest_epoch) === identity.epoch &&
    rows[0]!.manifest_hash.equals(hexToBytea(identity.hash));
}
