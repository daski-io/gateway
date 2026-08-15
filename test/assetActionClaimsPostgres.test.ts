import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";
import {
  assertDestructiveFollowUp,
  claimAssetAction,
  recordAssetActionStage,
  recordAssetActionState,
  type AssetActionClaim,
} from "../src/standardRail/assetActionClaims.js";
import type { Hex } from "../src/types.js";

const databaseUrl = process.env.DATABASE_URL_TEST ??
  "postgresql://postgres:password@localhost:5433/daski_gateway_test";
const hash = (digit: string): Hex => `0x${digit.repeat(64)}` as Hex;
const payer = "0x1111111111111111111111111111111111111111" as Hex;

function claim(executionId: Hex, overrides: Partial<AssetActionClaim> = {}): AssetActionClaim {
  return {
    executionId,
    payer,
    providerAgentId: "provider-1",
    serviceId: hash("2"),
    operation: "use",
    stagedExecutionId: null,
    walletAuthorizationHash: hash("3"),
    requestHash: hash("4"),
    providerControlProfileHash: hash("5"),
    servicingAdmissionHash: hash("6"),
    actionCatalogHash: hash("7"),
    actionCatalogSchemaHash: hash("8"),
    actionCatalogEpoch: 1,
    actionDefinitionHash: hash("9"),
    stageValidBefore: Math.floor(Date.now() / 1_000) + 3_600,
    ...overrides,
  };
}

describe("destructive asset claims against PostgreSQL", () => {
  it("enforces stage caps, delay binding, and exact terminal replay", async () => {
    const schema = `asset_claims_${randomUUID().replaceAll("-", "")}`;
    const bootstrap = createPool({ connectionString: databaseUrl, max: 1 });
    await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    const pool = createPool({ connectionString: databaseUrl, searchPath: schema, max: 3 });
    try {
      await pool.query(`CREATE TABLE standard_asset_action_claims (
        execution_id BYTEA PRIMARY KEY,
        payer TEXT NOT NULL,
        provider_agent_id TEXT NOT NULL,
        service_id BYTEA NOT NULL,
        operation TEXT NOT NULL,
        staged_execution_id BYTEA,
        wallet_authorization_hash BYTEA NOT NULL,
        request_hash BYTEA NOT NULL,
        provider_control_profile_hash BYTEA NOT NULL,
        servicing_admission_hash BYTEA NOT NULL,
        action_catalog_hash BYTEA NOT NULL,
        action_catalog_schema_hash BYTEA NOT NULL,
        action_catalog_epoch BIGINT NOT NULL,
        action_definition_hash BYTEA NOT NULL,
        state TEXT NOT NULL,
        expires_at TIMESTAMPTZ,
        confirmation_hash BYTEA,
        earliest_execution_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

      const stagedId = hash("a");
      const followUpId = hash("b");
      const confirmationHash = hash("c");
      await claimAssetAction(pool, claim(stagedId));
      await recordAssetActionStage(
        pool,
        stagedId,
        confirmationHash,
        Math.floor(Date.now() / 1_000) + 600,
        Math.floor(Date.now() / 1_000) + 3_600,
      );
      await expect(assertDestructiveFollowUp(pool, {
        payer,
        providerAgentId: "provider-1",
        actionDefinitionHash: hash("9"),
        executionId: stagedId,
        followUpExecutionId: followUpId,
        confirmationHash,
        operation: "confirm",
      })).rejects.toThrow("ASSET_DESTRUCTIVE_DELAY_ACTIVE");

      await assertDestructiveFollowUp(pool, {
        payer,
        providerAgentId: "provider-1",
        actionDefinitionHash: hash("9"),
        executionId: stagedId,
        followUpExecutionId: followUpId,
        confirmationHash,
        operation: "cancel",
      });
      await claimAssetAction(pool, claim(followUpId, {
        operation: "cancel",
        stagedExecutionId: stagedId,
        stageValidBefore: null,
      }));
      await recordAssetActionState(pool, stagedId, "canceled");
      await recordAssetActionState(pool, followUpId, "completed");
      await expect(assertDestructiveFollowUp(pool, {
        payer,
        providerAgentId: "provider-1",
        actionDefinitionHash: hash("9"),
        executionId: stagedId,
        followUpExecutionId: followUpId,
        confirmationHash,
        operation: "cancel",
      })).resolves.toBeUndefined();
      await expect(assertDestructiveFollowUp(pool, {
        payer,
        providerAgentId: "provider-1",
        actionDefinitionHash: hash("9"),
        executionId: stagedId,
        followUpExecutionId: hash("d"),
        confirmationHash,
        operation: "cancel",
      })).rejects.toThrow("ASSET_DESTRUCTIVE_CONFIRMATION_REQUIRED");

      for (const digit of ["1", "2", "3", "4", "5"]) {
        await claimAssetAction(pool, claim(hash(digit), {
          payer: "0x2222222222222222222222222222222222222222",
        }));
      }
      await expect(claimAssetAction(pool, claim(hash("6"), {
        payer: "0x2222222222222222222222222222222222222222",
      }))).rejects.toThrow("WALLET_RATE_LIMITED");
    } finally {
      await pool.end();
      await bootstrap.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
      await bootstrap.end();
    }
  });
});
