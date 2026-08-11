import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { ApprovedBazaarRuntimeManifestIdentity } from
  "./runtimeManifestApproval.js";
import { withActiveBazaarRuntimeManifest } from "./runtimeManifestStore.js";

const RUNTIME_EXECUTION_LEASE_SECONDS = 120;

export interface BazaarRuntimeExecutionLease {
  executionId: Hex;
  leaseToken: string;
}

export class BazaarRuntimeExecutionStore {
  constructor(
    private readonly pool: Pool,
    private readonly identity: ApprovedBazaarRuntimeManifestIdentity,
    private readonly leaseOwner: string,
  ) {}

  async begin(): Promise<BazaarRuntimeExecutionLease | null> {
    const executionId = nonzeroExecutionId();
    const leaseToken = randomUUID();
    const result = await withActiveBazaarRuntimeManifest({
      pool: this.pool,
      identity: this.identity,
      action: async (client) => {
        await client.query(
          "DELETE FROM bazaar_runtime_executions WHERE lease_expires_at <= now()",
        );
        await client.query(
          `INSERT INTO bazaar_runtime_executions
             (execution_id, manifest_epoch, manifest_hash, lease_token,
              lease_owner, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5,
             now() + make_interval(secs => $6))`,
          [
            hexToBytea(executionId), this.identity.epoch.toString(),
            hexToBytea(this.identity.hash), leaseToken, this.leaseOwner,
            RUNTIME_EXECUTION_LEASE_SECONDS,
          ],
        );
        return { executionId, leaseToken };
      },
    });
    return result.active ? result.value : null;
  }

  async renewLease(executionId: Hex, leaseToken: string): Promise<boolean> {
    const result = await withActiveBazaarRuntimeManifest({
      pool: this.pool,
      identity: this.identity,
      action: async (client) => {
        const renewed = await client.query(
          `UPDATE bazaar_runtime_executions
              SET lease_expires_at = now() + make_interval(secs => $3)
            WHERE execution_id = $1 AND lease_token = $2
              AND lease_expires_at > now()`,
          [
            hexToBytea(executionId), leaseToken,
            RUNTIME_EXECUTION_LEASE_SECONDS,
          ],
        );
        return renewed.rowCount === 1;
      },
    });
    return result.active && result.value;
  }

  async complete(executionId: Hex, leaseToken: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM bazaar_runtime_executions
        WHERE execution_id = $1 AND lease_token = $2
          AND lease_expires_at > now()`,
      [hexToBytea(executionId), leaseToken],
    );
    return result.rowCount === 1;
  }
}

function nonzeroExecutionId(): Hex {
  const bytes = randomBytes(32);
  if (bytes.every((byte) => byte === 0)) {
    throw new Error("Bazaar runtime execution identifier is invalid");
  }
  return `0x${bytes.toString("hex")}` as Hex;
}
