import type { Pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { Hex } from "../types.js";
import { canonicalHash } from "./canonical.js";
import { signEnvelope } from "./signing.js";

export type RetirementScope = {
  kind: "listing"; providerAgentId: string; serviceId: string; listingManifestHash: string;
} | {
  kind: "asset-action"; providerAgentId: string; serviceId: string; actionDefinitionHash: string;
};
export interface RetirementPayload { requestId: string; scope: RetirementScope; retiredAt: string }
export type RetirementBlockers = Record<string, number>;
export class RetirementBlocked extends Error {
  constructor(readonly scope: RetirementScope, readonly blockers: RetirementBlockers) { super("RETIREMENT_BLOCKED"); }
}
export function parseRetirementScope(raw: unknown): RetirementScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_RETIREMENT_SCOPE");
  const value = raw as Record<string, unknown>;
  const hex = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
  if (typeof value.providerAgentId !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value.providerAgentId) ||
      !hex(value.serviceId)) throw new Error("INVALID_RETIREMENT_SCOPE");
  const common = { providerAgentId: value.providerAgentId, serviceId: value.serviceId };
  if (value.kind === "listing" && hex(value.listingManifestHash)) {
    return { kind: "listing", ...common, listingManifestHash: value.listingManifestHash };
  }
  if (value.kind === "asset-action" && hex(value.actionDefinitionHash)) {
    return { kind: "asset-action", ...common, actionDefinitionHash: value.actionDefinitionHash };
  }
  throw new Error("INVALID_RETIREMENT_SCOPE");
}
const bytes = (value: string) => Buffer.from(value.slice(2), "hex");
const hash = (scope: RetirementScope) => scope.kind === "listing" ? scope.listingManifestHash : scope.actionDefinitionHash;
type Queryable = Pick<PoolClient, "query">;
interface ReceiptRow { receipt_payload: RetirementPayload; provider_audience: string }

export class ReleaseRetirements {
  constructor(private readonly pool: Pool, private readonly signing: {
    environment: string; chainId: number; privateKey: Hex;
    providerAudience: (providerAgentId: string) => string;
  }) {}

  async inventory(): Promise<RetirementPayload[]> {
    const result = await this.pool.query<ReceiptRow>("SELECT receipt_payload FROM standard_contract_retirements ORDER BY provider_agent_id,kind,contract_hash");
    return result.rows.map(row => row.receipt_payload);
  }

  async retainedAdmissions() {
    const result = await this.pool.query<{
      provider_agent_id: string; admission_hash: Buffer; canonical_admission: {payload:{actionCatalogEpoch:number;actionCatalogHash:string}};
      current: boolean; catalog: {payload:{actions:Array<{serviceId:string;actionDefinitionHash:string}>}} | null;
    }>(`SELECT s.provider_agent_id,s.admission_hash,s.canonical_admission,s.current,a.canonical_json AS catalog
      FROM standard_provider_servicing_admissions s LEFT JOIN standard_rail_artifacts a
        ON a.artifact_hash=decode(substring(s.canonical_admission->'payload'->>'actionCatalogHash',3),'hex')
      ORDER BY s.provider_agent_id,s.admitted_at,s.admission_hash`);
    return result.rows.map(row => ({providerAgentId:row.provider_agent_id,admissionHash:"0x"+row.admission_hash.toString("hex"),
      epoch:row.canonical_admission.payload.actionCatalogEpoch,current:row.current,
      actionCatalogHash:row.canonical_admission.payload.actionCatalogHash,catalogKnown:row.catalog!==null,
      actions:row.catalog?.payload.actions.map(action=>({serviceId:action.serviceId,actionDefinitionHash:action.actionDefinitionHash})) ?? null}));
  }

  private async existing(db: Queryable, scope: RetirementScope): Promise<ReceiptRow | null> {
    const result = await db.query<ReceiptRow>(
      "SELECT receipt_payload,provider_audience FROM standard_contract_retirements WHERE provider_agent_id=$1 AND kind=$2 AND contract_hash=$3",
      [scope.providerAgentId,scope.kind,bytes(hash(scope))]);
    const row = result.rows[0];
    if (row && canonicalHash(row.receipt_payload.scope) !== canonicalHash(scope)) throw new Error("RETIREMENT_SCOPE_CONFLICT");
    return row ?? null;
  }

  private async response(row: ReceiptRow) {
    const now = Math.floor(Date.now() / 1000);
    return { scope: row.receipt_payload.scope, retired: true as const,
      receipt: await signEnvelope({ artifactType: "GatewayContractRetirementV1", schemaVersion: 1,
        environment: this.signing.environment, chainId: this.signing.chainId, audience: row.provider_audience,
        signerKeyId: "gateway-dispatch", privateKey: this.signing.privateKey, issuedAt: now, validBefore: now + 86400,
        payload: row.receipt_payload }) };
  }

  /** Counts are a preview. Only retire() issues a proof under writer-shared locks. */
  async state(raw: unknown) {
    const scope = parseRetirementScope(raw);
    const existing = await this.existing(this.pool, scope);
    if (existing) return this.response(existing);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const blockers = await this.blockers(client, scope);
      await client.query("COMMIT");
      return { scope, retired: false as const, blockers };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async retire(raw: unknown) {
    const scope = parseRetirementScope(raw);
    const requestId = (raw as Record<string, unknown>).requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new Error("INVALID_RETIREMENT_REQUEST");
    const requestHash = canonicalHash({ requestId, scope });
    const client = await this.pool.connect();
    let stored: ReceiptRow;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["contract-retirement-request:" + requestId]);
      const reused = await client.query<{ request_hash: string }>("SELECT request_hash FROM standard_contract_retirements WHERE request_id=$1", [requestId]);
      if (reused.rows[0] && reused.rows[0].request_hash !== requestHash) throw new Error("RETIREMENT_REQUEST_ID_REUSED");
      if (scope.kind === "asset-action") {
        const guard = "standard:servicing-admission:" + scope.providerAgentId;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [guard]);
        await client.query("SELECT standard_touch_release_guard($1)", [guard]);
      }
      const values = [scope.providerAgentId,scope.kind,bytes(hash(scope))];
      await client.query("INSERT INTO standard_contract_retirement_guards(provider_agent_id,kind,contract_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",values);
      // Every legacy/new creator of an obligation holds this same row FOR SHARE.
      // This write also makes a waiting stale SERIALIZABLE reader retry.
      await client.query("UPDATE standard_contract_retirement_guards SET generation=generation+1 WHERE provider_agent_id=$1 AND kind=$2 AND contract_hash=$3",values);
      const existing = await this.existing(client,scope);
      if (existing) stored = existing;
      else {
        const blockers = await this.blockers(client,scope);
        if (Object.values(blockers).some(count => count > 0)) throw new RetirementBlocked(scope,blockers);
        const providerAudience = this.signing.providerAudience(scope.providerAgentId);
        if (!providerAudience) throw new Error("RETIREMENT_PROVIDER_AUDIENCE_REQUIRED");
        const payload: RetirementPayload = { requestId, scope, retiredAt: new Date().toISOString() };
        await client.query(
          "INSERT INTO standard_contract_retirements(provider_agent_id,kind,contract_hash,service_id,request_id,request_hash,provider_audience,receipt_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [...values,bytes(scope.serviceId),requestId,requestHash,providerAudience,payload]);
        stored = { receipt_payload: payload, provider_audience: providerAudience };
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    return this.response(stored!);
  }

  private async blockers(db: Queryable, scope: RetirementScope): Promise<RetirementBlockers> {
    if (scope.kind === "asset-action") {
      const result = await db.query<Record<string, number>>(
        `WITH catalogs AS (
          SELECT a.canonical_json->'payload' AS payload FROM standard_rail_artifacts a
          WHERE a.artifact_type='ProviderAssetActionCatalogV1' AND a.canonical_json->'payload'->>'providerAgentId'=$1
        ), current_catalogs AS (
          SELECT a.canonical_json->'payload' AS payload, (s.canonical_admission->'payload'->>'actionCatalogEpoch')::bigint AS epoch FROM standard_provider_servicing_admissions s
          LEFT JOIN standard_rail_artifacts a ON a.artifact_hash=decode(substring(s.canonical_admission->'payload'->>'actionCatalogHash',3),'hex')
          WHERE s.provider_agent_id=$1 AND s.current
        )
        SELECT
          (CASE WHEN EXISTS(SELECT 1 FROM catalogs c,LATERAL jsonb_array_elements(c.payload->'actions') action
            WHERE action->>'serviceId'=$2 AND action->>'actionDefinitionHash'=$3) THEN 0 ELSE 1 END)::int AS "unknownScope",
          (CASE WHEN EXISTS(SELECT 1 FROM current_catalogs) AND NOT EXISTS(SELECT 1 FROM current_catalogs WHERE payload IS NULL)
            THEN 0 ELSE 1 END)::int AS "unknownCurrentAdmission",
          (SELECT count(*)::int FROM current_catalogs c,LATERAL jsonb_array_elements(c.payload->'actions') action
            WHERE action->>'actionDefinitionHash'=$3) AS "activeAdmissions",
          (SELECT count(*)::int FROM current_catalogs current WHERE current.epoch<=
            (SELECT max((c.payload->>'actionCatalogEpoch')::bigint) FROM catalogs c,LATERAL jsonb_array_elements(c.payload->'actions') action
              WHERE action->>'serviceId'=$2 AND action->>'actionDefinitionHash'=$3)) AS "retiringEpochRequired",
          (SELECT count(*)::int FROM standard_asset_action_targets t WHERE t.provider_agent_id=$1
            AND NOT EXISTS(SELECT 1 FROM current_catalogs c WHERE c.epoch=t.target_epoch)) AS "pendingTargets",
          (SELECT count(*)::int FROM standard_asset_action_claims WHERE provider_agent_id=$1 AND action_definition_hash=$4
            AND state NOT IN ('completed','canceled')) AS "openClaims",
          (SELECT count(*)::int FROM standard_asset_action_claims c WHERE c.provider_agent_id=$1 AND c.action_definition_hash=$4
            AND c.state='canceled' AND (c.operation IN ('confirm','recover') OR
              EXISTS(SELECT 1 FROM standard_asset_action_claims f WHERE f.staged_execution_id=c.execution_id AND f.state<>'completed'))) AS "unresolvedCanceledClaims"`,
        [scope.providerAgentId,scope.serviceId,scope.actionDefinitionHash,bytes(scope.actionDefinitionHash)]);
      return result.rows[0]!;
    }
    const result = await db.query<Record<string, number>>(
      `WITH orders AS (SELECT * FROM standard_orders WHERE provider_agent_id=$1 AND listing_manifest_hash=$3),
      registrations AS (
        SELECT r.* FROM standard_service_registrations r JOIN standard_service_listings l USING(registration_id)
        WHERE r.provider_agent_id=$1 AND r.service_id=$2 AND l.runtime_commitment_hash=$3
      )
      SELECT
        (CASE WHEN EXISTS(SELECT 1 FROM registrations) OR EXISTS(SELECT 1 FROM orders WHERE canonical_listing->'commitment'->'payload'->>'serviceId'=$4)
          THEN 0 ELSE 1 END)::int AS "unknownScope",
        (SELECT count(*)::int FROM registrations WHERE state IN ('ACTIVE','PREPARED','EVIDENCE_PENDING')) AS "activeRegistrations",
        (SELECT count(*)::int FROM orders WHERE state NOT IN ('FULFILLED','NOT_SETTLED')) AS "openOrders",
        (SELECT count(*)::int FROM orders WHERE lease_owner IS NOT NULL AND lease_until>now()) AS "workerLeases",
        (SELECT count(*)::int FROM orders WHERE encrypted_payment_payload IS NOT NULL OR (
          state='NOT_SETTLED' AND authorization_key IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM standard_order_transitions t WHERE t.order_id=orders.order_id AND t.to_state='NOT_SETTLED'
              AND t.reason_code IN ('independent_chain_observation_no_capture','parked_authorization_finalized_unpaid')))) AS "unresolvedAuthorizations",
        (SELECT count(*)::int FROM standard_parked_authorizations p JOIN orders USING(order_id) WHERE p.finality_evidence IS NULL) AS "parkedAuthorizations",
        (SELECT count(*)::int FROM standard_settlement_attempts a JOIN orders o USING(order_id)
          WHERE a.settle_invoked_at IS NOT NULL AND o.state='FULFILLED' AND o.release_evidence_hash IS NULL) AS "unprovenSettlements",
        (SELECT count(*)::int FROM orders o WHERE o.state='FULFILLED' AND (
          o.deposit_evidence_hash IS NULL OR o.release_evidence_hash IS NULL OR
          NOT EXISTS(SELECT 1 FROM standard_rail_receipts r WHERE r.order_id=o.order_id))) AS "unprovenFulfillment",
        (SELECT count(*)::int FROM standard_dispatch_claims d JOIN orders USING(order_id) WHERE d.resolved_at IS NULL OR d.invocation_state<>'accepted') AS "unresolvedDispatches",
        (SELECT count(*)::int FROM standard_capacity_reservations c JOIN orders USING(order_id) WHERE c.state='open') AS "capacityReservations",
        (SELECT count(*)::int FROM standard_reputation_operations r JOIN orders USING(order_id)
          WHERE r.state NOT IN ('final','aborted_unattested','blocked_parent_aborted','confirmation_failed','superseded')
            OR (r.state='final' AND r.kind IN ('confirmation','confirmation-v2') AND r.confirmation_reconciled_at IS NULL)) AS "reputationOperations",
        (SELECT count(*)::int FROM standard_reputation_transactions t JOIN standard_reputation_operations r USING(operation_id) JOIN orders USING(order_id)
          WHERE t.state<>'final' AND NOT (t.state='failed' AND (t.final_at IS NOT NULL OR EXISTS(
            SELECT 1 FROM standard_review_recovery rr WHERE rr.operation_id=r.operation_id)))) AS "unresolvedTransactions",
        (SELECT count(*)::int FROM standard_review_preparations p JOIN orders USING(order_id)
          WHERE (p.signed_deadline IS NULL OR p.signed_deadline>extract(epoch FROM now()))
            AND NOT EXISTS(SELECT 1 FROM standard_review_sponsorships s JOIN standard_review_recovery r USING(operation_id)
              WHERE s.preparation_id=p.preparation_id)) AS "relayableReviewAuthorizations",
        (SELECT count(*)::int FROM standard_review_sponsorships s JOIN orders USING(order_id) WHERE s.state='reserved') AS "sponsorshipReservations",
        (SELECT count(*)::int FROM standard_security_incidents s JOIN orders USING(order_id) WHERE s.resolved_at IS NULL) AS "securityIncidents"`,
      [scope.providerAgentId,bytes(scope.serviceId),bytes(scope.listingManifestHash),scope.serviceId]);
    return result.rows[0]!;
  }
}
