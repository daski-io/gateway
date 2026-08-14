import type { Hex } from "viem";
import type { Pool } from "../db/pool.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}`;

interface ClaimRow {
  payer: string;
  provider_agent_id: string;
  service_id: Buffer;
  operation: "use" | "confirm" | "cancel" | "recover";
  staged_execution_id: Buffer | null;
  wallet_authorization_hash: Buffer;
  request_hash: Buffer;
  provider_control_profile_hash: Buffer;
  servicing_admission_hash: Buffer;
  action_catalog_hash: Buffer;
  action_catalog_schema_hash: Buffer;
  action_catalog_epoch: string;
  action_definition_hash: Buffer;
}

export interface AssetActionClaim {
  executionId: Hex;
  payer: Hex;
  providerAgentId: string;
  serviceId: Hex;
  operation: "use" | "confirm" | "cancel" | "recover";
  stagedExecutionId: Hex | null;
  walletAuthorizationHash: Hex;
  requestHash: Hex;
  providerControlProfileHash: Hex;
  servicingAdmissionHash: Hex;
  actionCatalogHash: Hex;
  actionCatalogSchemaHash: Hex;
  actionCatalogEpoch: number;
  actionDefinitionHash: Hex;
}

export async function claimAssetAction(
  pool: Pool,
  claim: AssetActionClaim,
): Promise<void> {
  await pool.query(
    `INSERT INTO standard_asset_action_claims
      (execution_id,payer,provider_agent_id,service_id,operation,staged_execution_id,
       wallet_authorization_hash,request_hash,provider_control_profile_hash,
       servicing_admission_hash,action_catalog_hash,action_catalog_schema_hash,
       action_catalog_epoch,action_definition_hash,state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'claimed')
     ON CONFLICT (execution_id) DO NOTHING`,
    [
      bytes(claim.executionId), claim.payer, claim.providerAgentId, bytes(claim.serviceId),
      claim.operation, claim.stagedExecutionId ? bytes(claim.stagedExecutionId) : null,
      bytes(claim.walletAuthorizationHash), bytes(claim.requestHash),
      bytes(claim.providerControlProfileHash), bytes(claim.servicingAdmissionHash),
      bytes(claim.actionCatalogHash), bytes(claim.actionCatalogSchemaHash),
      claim.actionCatalogEpoch, bytes(claim.actionDefinitionHash),
    ],
  );
  const result = await pool.query<ClaimRow>(
    "SELECT * FROM standard_asset_action_claims WHERE execution_id=$1",
    [bytes(claim.executionId)],
  );
  const row = result.rows[0];
  if (
    !row || row.payer !== claim.payer || row.provider_agent_id !== claim.providerAgentId ||
    hex(row.service_id) !== claim.serviceId || row.operation !== claim.operation ||
    (row.staged_execution_id ? hex(row.staged_execution_id) : null) !== claim.stagedExecutionId ||
    hex(row.wallet_authorization_hash) !== claim.walletAuthorizationHash ||
    hex(row.request_hash) !== claim.requestHash ||
    hex(row.provider_control_profile_hash) !== claim.providerControlProfileHash ||
    hex(row.servicing_admission_hash) !== claim.servicingAdmissionHash ||
    hex(row.action_catalog_hash) !== claim.actionCatalogHash ||
    hex(row.action_catalog_schema_hash) !== claim.actionCatalogSchemaHash ||
    Number(row.action_catalog_epoch) !== claim.actionCatalogEpoch ||
    hex(row.action_definition_hash) !== claim.actionDefinitionHash
  ) throw new Error("asset action claim mismatch");
}

export async function recordAssetActionState(
  pool: Pool,
  executionId: Hex,
  state: "staged" | "completed" | "failed" | "canceled",
): Promise<void> {
  const result = await pool.query(
    `UPDATE standard_asset_action_claims SET state=$2,updated_at=now()
      WHERE execution_id=$1 AND (
        state IN ('claimed',$2) OR
        (state='staged' AND $2 IN ('completed','failed','canceled'))
      )`,
    [bytes(executionId), state],
  );
  if (result.rowCount !== 1) throw new Error("asset action claim state mismatch");
}
