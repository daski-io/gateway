import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export interface CutoverIdentity {
  environment: string;
  chainId: number;
  releaseCommit: string;
  manifestHash: Hex;
}

export interface CutoverStatus {
  legacyDatabase: boolean;
  pendingChallenges: number;
  unresolvedTransactions: number;
  approved: boolean;
}

async function relationExists(pool: Pool, name: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [name],
  );
  return result.rows[0]?.present === true;
}

export async function inspectStandardCutover(
  pool: Pool,
  identity: CutoverIdentity,
): Promise<CutoverStatus> {
  const hasChallenges = await relationExists(pool, "payment_challenges");
  const hasTransactions = await relationExists(pool, "facilitator_transactions");
  const legacyDatabase = hasChallenges || hasTransactions;
  const pendingChallenges = hasChallenges
    ? Number((await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM payment_challenges WHERE status='pending'",
    )).rows[0]?.count ?? 0)
    : 0;
  const unresolvedTransactions = hasTransactions
    ? Number((await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM facilitator_transactions WHERE status IN ('prepared','broadcast')",
    )).rows[0]?.count ?? 0)
    : 0;
  const approvalTable = await relationExists(pool, "_standard_cutover_approvals");
  const approved = approvalTable && (await pool.query(
    `SELECT 1 FROM _standard_cutover_approvals
      WHERE environment=$1 AND chain_id=$2 AND release_commit=$3 AND manifest_hash=$4`,
    [identity.environment, identity.chainId, identity.releaseCommit, bytes(identity.manifestHash)],
  )).rowCount === 1;
  return { legacyDatabase, pendingChallenges, unresolvedTransactions, approved };
}

export function assertCutoverReady(status: CutoverStatus): void {
  if (status.pendingChallenges > 0 || status.unresolvedTransactions > 0) {
    throw new Error("STANDARD_RAIL_CUTOVER_NOT_DRAINED");
  }
}

export async function approveStandardCutover(
  pool: Pool,
  identity: CutoverIdentity,
  archiveSha256: Hex,
): Promise<void> {
  const status = await inspectStandardCutover(pool, identity);
  if (!status.legacyDatabase) throw new Error("STANDARD_RAIL_CUTOVER_HAS_NO_LEGACY_STATE");
  assertCutoverReady(status);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _standard_cutover_approvals (
      environment TEXT NOT NULL,
      chain_id BIGINT NOT NULL,
      release_commit TEXT NOT NULL,
      manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
      archive_sha256 BYTEA NOT NULL CHECK (octet_length(archive_sha256) = 32),
      approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (environment,chain_id)
    )
  `);
  await pool.query(
    `INSERT INTO _standard_cutover_approvals(
       environment,chain_id,release_commit,manifest_hash,archive_sha256
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (environment,chain_id) DO UPDATE SET
       release_commit=EXCLUDED.release_commit,
       manifest_hash=EXCLUDED.manifest_hash,
       archive_sha256=EXCLUDED.archive_sha256,
       approved_at=now()`,
    [identity.environment, identity.chainId, identity.releaseCommit,
      bytes(identity.manifestHash), bytes(archiveSha256)],
  );
}

export async function assertDestructiveCutoverApproved(
  pool: Pool,
  identity: CutoverIdentity,
): Promise<void> {
  const status = await inspectStandardCutover(pool, identity);
  if (!status.legacyDatabase) return;
  assertCutoverReady(status);
  if (!status.approved) throw new Error("STANDARD_RAIL_CUTOVER_APPROVAL_REQUIRED");
}
