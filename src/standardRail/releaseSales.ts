import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";

export interface SaleScope { providerAgentId: string; serviceId: string; listingManifestHash: string }
export interface SaleRequest extends SaleScope { requestId: string; expectedRevision: number; acceptingNewOrders: boolean }
export interface SaleState extends SaleScope { revision: number; requestId: string | null; acceptingNewOrders: boolean }

export function parseSaleScope(raw: unknown): SaleScope {
  const value = raw as SaleScope;
  if (!value || typeof value.providerAgentId !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value.providerAgentId) ||
      typeof value.serviceId !== "string" || !/^0x[0-9a-f]{64}$/.test(value.serviceId) ||
      typeof value.listingManifestHash !== "string" || !/^0x[0-9a-f]{64}$/.test(value.listingManifestHash)) {
    throw new Error("INVALID_RELEASE_SCOPE");
  }
  return { providerAgentId: value.providerAgentId, serviceId: value.serviceId, listingManifestHash: value.listingManifestHash };
}

export function parseSaleRequest(raw: unknown): SaleRequest {
  const value = raw as SaleRequest;
  const scope = parseSaleScope(raw);
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.requestId) ||
      !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      value.expectedRevision >= Number.MAX_SAFE_INTEGER || typeof value.acceptingNewOrders !== "boolean") {
    throw new Error("INVALID_SALE_REQUEST");
  }
  return { ...scope, requestId: value.requestId, expectedRevision: value.expectedRevision, acceptingNewOrders: value.acceptingNewOrders };
}
const bytes = (value: string) => Buffer.from(value.slice(2), "hex");

export class ReleaseSales {
  constructor(private readonly pool: Pool) {}

  async state(scope: SaleScope): Promise<SaleState> {
    parseSaleScope(scope);
    const result = await this.pool.query<{ revision: string; request_id: string; accepting_new_orders: boolean }>(
      `SELECT revision,request_id,accepting_new_orders FROM standard_sale_controls
        WHERE provider_agent_id=$1 AND service_id=$2 AND listing_manifest_hash=$3`,
      [scope.providerAgentId,bytes(scope.serviceId),bytes(scope.listingManifestHash)]);
    const row = result.rows[0];
    return { ...scope, revision: row ? Number(row.revision) : 0, requestId: row?.request_id ?? null,
      acceptingNewOrders: row?.accepting_new_orders ?? true };
  }

  async assertOpen(providerAgentId: string, listingManifestHash: string): Promise<void> {
    const result = await this.pool.query(
      "SELECT 1 FROM standard_sale_controls WHERE provider_agent_id=$1 AND listing_manifest_hash=$2 AND NOT accepting_new_orders",
      [providerAgentId, bytes(listingManifestHash)]);
    if (result.rowCount) throw new Error("SALE_SUSPENDED");
  }

  async isParked(orderId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM standard_parked_authorizations WHERE order_id=$1", [orderId])).rowCount === 1;
  }

  async recordObservation(orderId: string, observation: Record<string, unknown>): Promise<void> {
    await this.pool.query("UPDATE standard_parked_authorizations SET observed_at=now(),observation=$2 WHERE order_id=$1",
      [orderId,observation]);
  }

  async recordFinality(orderId: string, evidence: Record<string, unknown>): Promise<void> {
    await this.pool.query("UPDATE standard_parked_authorizations SET observed_at=now(),finality_evidence=$2 WHERE order_id=$1",
      [orderId, evidence]);
  }

  async parkedStatus(orderId: string) {
    const result = await this.pool.query<{ parked_at: Date; observed_at: Date | null; observation: unknown; finality_evidence: unknown }>(
      "SELECT parked_at,observed_at,observation,finality_evidence FROM standard_parked_authorizations WHERE order_id=$1", [orderId]);
    return result.rows[0] ?? null;
  }

  async set(raw: SaleRequest): Promise<SaleState> {
    const request = parseSaleRequest(raw);
    const requestHash = canonicalHash(request);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`release-sale-request:${request.requestId}`]);
      const replay = await client.query<{ request_hash: string; response: SaleState }>(
        "SELECT request_hash,response FROM standard_sale_control_requests WHERE request_id=$1", [request.requestId]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new Error("SALE_REQUEST_ID_REUSED");
        await client.query("COMMIT");
        return replay.rows[0].response;
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`release-sale:${request.listingManifestHash.slice(2)}`]);
      await client.query("SELECT standard_touch_release_guard($1)",
        [`release-sale:${request.listingManifestHash.slice(2)}`]);
      const values = [request.providerAgentId,bytes(request.serviceId),bytes(request.listingManifestHash)];
      // Resolve the full tuple from persisted canonical facts before creating
      // any control. A typo in serviceId must never acknowledge a partial stop.
      const binding = await client.query(`
        SELECT 1 FROM standard_service_listings l
          JOIN standard_service_registrations r USING(registration_id)
          WHERE r.provider_agent_id=$1 AND r.service_id=$2 AND l.runtime_commitment_hash=$3
        UNION ALL
        SELECT 1 FROM standard_orders o WHERE o.provider_agent_id=$1 AND o.listing_manifest_hash=$3
          AND o.canonical_listing->'commitment'->'payload'->>'serviceId'=$4 LIMIT 1`,
        [...values,request.serviceId]);
      if (!binding.rowCount) throw new Error("SALE_SCOPE_NOT_FOUND");
      const current = await client.query<{ revision: string }>(
        `SELECT revision FROM standard_sale_controls
          WHERE provider_agent_id=$1 AND service_id=$2 AND listing_manifest_hash=$3 FOR UPDATE`, values);
      const revision = Number(current.rows[0]?.revision ?? 0);
      if (revision !== request.expectedRevision) throw new Error("SALE_REVISION_CONFLICT");
      const next = revision + 1;
      await client.query(`INSERT INTO standard_sale_controls
        (provider_agent_id,service_id,listing_manifest_hash,revision,request_id,accepting_new_orders)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(provider_agent_id,service_id,listing_manifest_hash)
        DO UPDATE SET revision=EXCLUDED.revision,request_id=EXCLUDED.request_id,
          accepting_new_orders=EXCLUDED.accepting_new_orders,updated_at=now()`,
        [...values,next,request.requestId,request.acceptingNewOrders]);
      if (!request.acceptingNewOrders) {
        await client.query(`INSERT INTO standard_parked_authorizations(order_id,sale_revision)
          SELECT o.order_id,$4 FROM standard_orders o JOIN standard_settlement_attempts a USING(order_id)
          WHERE o.provider_agent_id=$1 AND o.listing_manifest_hash=$3
            AND o.canonical_listing->'commitment'->'payload'->>'serviceId'=$2
            AND o.state IN ('ATTEMPT_OPENED','VERIFIED','VERIFY_REJECTED') AND a.settle_invoked_at IS NULL
          ON CONFLICT(order_id) DO NOTHING`,
          [request.providerAgentId,request.serviceId,bytes(request.listingManifestHash),next]);
      }
      const response: SaleState = { providerAgentId: request.providerAgentId, serviceId: request.serviceId,
        listingManifestHash: request.listingManifestHash, revision: next, requestId: request.requestId,
        acceptingNewOrders: request.acceptingNewOrders };
      await client.query("INSERT INTO standard_sale_control_requests(request_id,request_hash,response) VALUES($1,$2,$3)",
        [request.requestId,requestHash,response]);
      await client.query("COMMIT");
      return response;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
