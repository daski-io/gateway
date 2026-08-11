import type { PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";
import type { BazaarRuntimeManifestApproval } from "./types.js";

interface BazaarRuntimeManifestRow {
  manifest_epoch: string;
  manifest_hash: Buffer;
}

interface RawRuntimeTransitionIntent {
  source_epoch: string;
  source_hash: Buffer;
  target_epoch: string;
  target_hash: Buffer;
}

export async function establishBazaarRuntimeDrain(input: {
  client: PoolClient;
  current: BazaarRuntimeManifestRow;
  identity: ApprovedBazaarRuntimeManifestIdentity;
  approval: BazaarRuntimeManifestApproval;
  approvalDigest: Hex;
}): Promise<void> {
  const active = await input.client.query<RawRuntimeTransitionIntent>(
    `SELECT source_epoch, source_hash, target_epoch, target_hash
       FROM bazaar_runtime_transition_intents
      WHERE state = 'draining' FOR UPDATE`,
  );
  const pending = active.rows[0];
  if (active.rows.length > 1) {
    throw new Error("Bazaar runtime drain invariant violated");
  }
  if (pending) {
    assertMatchingSource(pending, input.current);
    const targetEpoch = BigInt(pending.target_epoch);
    if (
      input.identity.epoch === targetEpoch &&
      pending.target_hash.equals(hexToBytea(input.identity.hash))
    ) return;
    if (input.identity.epoch <= targetEpoch) {
      throw new Error("Bazaar runtime drain target conflicts with signed intent");
    }
    await input.client.query(
      `UPDATE bazaar_runtime_transition_intents
          SET state = 'superseded',
              completed_at = GREATEST(now(), requested_at)
        WHERE state = 'draining'`,
    );
  }
  await input.client.query(
    `INSERT INTO bazaar_runtime_transition_intents
       (source_epoch, source_hash, target_epoch, target_hash, approval_digest,
        approval_signature, approval_issued_at, approval_valid_before, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draining')`,
    [
      input.current.manifest_epoch, input.current.manifest_hash,
      input.identity.epoch.toString(), hexToBytea(input.identity.hash),
      hexToBytea(input.approvalDigest), hexToBytea(input.approval.signature),
      input.approval.issuedAt.toString(), input.approval.validBefore.toString(),
    ],
  );
}

export async function completeBazaarRuntimeDrain(input: {
  client: PoolClient;
  current: BazaarRuntimeManifestRow;
  identity: ApprovedBazaarRuntimeManifestIdentity;
}): Promise<void> {
  const completed = await input.client.query(
    `UPDATE bazaar_runtime_transition_intents
        SET state = 'activated',
            completed_at = GREATEST(now(), requested_at)
      WHERE state = 'draining' AND source_epoch = $1 AND source_hash = $2
        AND target_epoch = $3 AND target_hash = $4`,
    [
      input.current.manifest_epoch, input.current.manifest_hash,
      input.identity.epoch.toString(), hexToBytea(input.identity.hash),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("Bazaar runtime drain completion invariant violated");
  }
}

export async function hasBazaarRuntimeDrain(
  client: PoolClient,
): Promise<boolean> {
  const active = await client.query(
    "SELECT 1 FROM bazaar_runtime_transition_intents WHERE state = 'draining'",
  );
  return active.rowCount === 1;
}

export async function hasLiveBazaarWork(client: PoolClient): Promise<boolean> {
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
  return live.rowCount === 1;
}

function assertMatchingSource(
  pending: RawRuntimeTransitionIntent,
  current: BazaarRuntimeManifestRow,
): void {
  if (
    pending.source_epoch !== current.manifest_epoch ||
    !pending.source_hash.equals(current.manifest_hash)
  ) throw new Error("Bazaar runtime drain source invariant violated");
}
