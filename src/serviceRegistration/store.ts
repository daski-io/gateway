import type { Pool } from "../db/pool.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { SignedEnvelope } from "../standardRail/types.js";

interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

import type {
  PreparedServiceRegistration,
  ProviderServiceCard,
  ProviderServiceRegistrationEvidenceEnvelope,
  ProviderServiceRegistrationIntentEnvelope,
} from "./types.js";

interface RegistrationRow {
  registration_id: string;
  provider_agent_id: string;
  service_id: Buffer;
  service_slug: string;
  service_version: string;
  supersedes_registration_id: string | null;
  agent_card_url: string;
  service_wallet: string;
  idempotency_key: string;
  provider_owner: string;
  provider_agent_wallet: string;
  provider_signer: string;
  provider_payee: string;
  request_hash: Buffer;
  canonical_intent: ProviderServiceRegistrationIntentEnvelope;
  prepared_json: PreparedServiceRegistration;
  card_json: ProviderServiceCard;
  state: PreparedServiceRegistration["state"];
  marketplace_enabled: boolean;
  marketplace_enabled_by: string;
  marketplace_enabled_at: Date;
  card_accepting_orders: boolean;
  chain_active: boolean;
  evidence_nonce: Buffer | null;
  registration_healthy: boolean;
  canonical_evidence: ProviderServiceRegistrationEvidenceEnvelope | null;
  refresh_failures: number;
  last_refresh_error_code: string | null;
  last_refreshed_at: Date | null;
  last_refresh_attempted_at: Date | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface StoredRegistration {
  registrationId: string;
  providerAgentId: string;
  serviceId: `0x${string}`;
  serviceSlug: string;
  serviceVersion: string;
  supersedesRegistrationId: string | null;
  agentCardUrl: string;
  serviceWallet: string;
  idempotencyKey: string;
  providerPayee: string;
  providerOwner: string;
  providerAgentWallet: string;
  providerSigner: string;
  requestHash: `0x${string}`;
  intent: ProviderServiceRegistrationIntentEnvelope;
  prepared: PreparedServiceRegistration;
  card: ProviderServiceCard;
  state: PreparedServiceRegistration["state"];
  marketplaceEnabled: boolean;
  marketplaceEnabledBy: string;
  marketplaceEnabledAt: Date;
  cardAcceptingOrders: boolean;
  chainActive: boolean;
  evidence: ProviderServiceRegistrationEvidenceEnvelope | null;
  registrationHealthy: boolean;
  refreshFailures: number;
  lastRefreshErrorCode: string | null;
  lastRefreshedAt: Date | null;
  activatedAt: Date | null;
  lastRefreshAttemptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function bytes(value: string): Buffer {
  return Buffer.from(value.slice(2), "hex");
}

function hex(value: Buffer): `0x${string}` {
  return `0x${value.toString("hex")}`;
}

function mapRow(row: RegistrationRow): StoredRegistration {
  return {
    registrationId: row.registration_id,
    providerAgentId: row.provider_agent_id,
    serviceId: hex(row.service_id),
    serviceSlug: row.service_slug,
    serviceVersion: row.service_version,
    supersedesRegistrationId: row.supersedes_registration_id,
    agentCardUrl: row.agent_card_url,
    serviceWallet: row.service_wallet,
    idempotencyKey: row.idempotency_key,
    requestHash: hex(row.request_hash),
    providerPayee: row.provider_payee,
    providerOwner: row.provider_owner,
    providerAgentWallet: row.provider_agent_wallet,
    providerSigner: row.provider_signer,
    intent: row.canonical_intent,
    prepared: row.prepared_json,
    card: row.card_json,
    state: row.state,
    marketplaceEnabled: row.marketplace_enabled,
    marketplaceEnabledBy: row.marketplace_enabled_by,
    marketplaceEnabledAt: row.marketplace_enabled_at,
    cardAcceptingOrders: row.card_accepting_orders,
    chainActive: row.chain_active,
    evidence: row.canonical_evidence,
    registrationHealthy: row.registration_healthy,
    refreshFailures: row.refresh_failures,
    lastRefreshErrorCode: row.last_refresh_error_code,
    lastRefreshedAt: row.last_refreshed_at,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshAttemptedAt: row.last_refresh_attempted_at,
  };
}

async function selectOne(
  pool: Pool,
  sql: string,
  values: unknown[],
): Promise<StoredRegistration | null> {
  const result = await pool.query<RegistrationRow>(sql, values);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function persistArtifact(
  db: Queryable,
  envelope: SignedEnvelope<unknown, number>,
  epoch: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO standard_rail_artifacts
      (artifact_hash,artifact_type,schema_version,environment,chain_id,epoch,
       canonical_json,valid_before,recovery_valid_before)
     VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),NULL)
     ON CONFLICT (artifact_hash) DO NOTHING`,
    [
      bytes(canonicalHash(envelope)),
      envelope.artifactType,
      envelope.schemaVersion,
      envelope.environment,
      envelope.chainId,
      epoch,
      envelope,
      envelope.validBefore,
    ],
  );
}

export class ServiceRegistrationStore {
  constructor(private readonly pool: Pool) {}

  getByIdempotency(
    providerAgentId: string,
    idempotencyKey: string,
  ): Promise<StoredRegistration | null> {
    return selectOne(
      this.pool,
      `SELECT * FROM standard_service_registrations
        WHERE provider_agent_id=$1 AND idempotency_key=$2`,
      [providerAgentId, idempotencyKey],
    );
  }

  get(registrationId: string): Promise<StoredRegistration | null> {
    return selectOne(
      this.pool,
      "SELECT * FROM standard_service_registrations WHERE registration_id=$1",
      [registrationId],
    );
  }

  getActiveByServiceId(serviceId: `0x${string}`): Promise<StoredRegistration | null> {
    return selectOne(
      this.pool,
      `SELECT * FROM standard_service_registrations
        WHERE service_id=$1 AND state='ACTIVE'`,
      [bytes(serviceId)],
    );
  }

  getPendingByServiceId(serviceId: `0x${string}`): Promise<StoredRegistration | null> {
    return selectOne(
      this.pool,
      `SELECT * FROM standard_service_registrations
        WHERE service_id=$1 AND state IN ('PREPARED','EVIDENCE_PENDING')`,
      [bytes(serviceId)],
    );
  }

  async create(args: {
    intent: ProviderServiceRegistrationIntentEnvelope;
    requestHash: `0x${string}`;
    idempotencyKey: string;
    serviceId: `0x${string}`;
    card: ProviderServiceCard;
    cardHash: `0x${string}`;
    prepared: PreparedServiceRegistration;
    providerOwner: string;
    providerAgentWallet: string;
    providerSigner: string;
    supersedesRegistrationId: string | null;
  }): Promise<{ record: StoredRegistration; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const payload = args.intent.payload;
      const inserted = await client.query<RegistrationRow>(
        `INSERT INTO standard_service_registrations
          (registration_id,provider_agent_id,service_id,service_slug,service_version,
           supersedes_registration_id,agent_card_url,service_wallet,provider_owner,
           provider_agent_wallet,provider_signer,provider_payee,idempotency_key,
           registration_nonce,request_hash,canonical_intent,prepared_json,card_json,
           card_hash,skill_contract_set_hash,state,marketplace_enabled,
           marketplace_enabled_by,card_accepting_orders)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,'PREPARED',$21,$22,$23)
         ON CONFLICT (provider_agent_id,idempotency_key) DO NOTHING
         RETURNING *`,
        [
          args.prepared.registrationId,
          payload.providerAgentId,
          bytes(args.serviceId),
          payload.serviceSlug,
          payload.serviceVersion,
          args.supersedesRegistrationId,
          args.prepared.agentCardUrl,
          args.prepared.serviceWallet.toLowerCase(),
          args.providerOwner.toLowerCase(),
          args.providerAgentWallet.toLowerCase(),
          args.providerSigner.toLowerCase(),
          args.prepared.providerPayee.toLowerCase(),
          args.idempotencyKey,
          bytes(payload.registrationNonce),
          bytes(args.requestHash),
          args.intent,
          args.prepared,
          args.card,
          bytes(args.cardHash),
          bytes(args.card.skillContractSetHash),
          args.prepared.marketplaceEnabled,
          args.supersedesRegistrationId
            ? "inherited-service-visibility"
            : "environment-default",
          args.card.service.acceptingNewOrders,
        ],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<RegistrationRow>(
          `SELECT * FROM standard_service_registrations
            WHERE provider_agent_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [payload.providerAgentId, args.idempotencyKey],
        );
        row = existing.rows[0];
        if (!row || !row.request_hash.equals(bytes(args.requestHash))) {
          throw new Error("IDEMPOTENCY_KEY_REUSED");
        }
        await client.query("COMMIT");
        return { record: mapRow(row), created: false };
      }

      await persistArtifact(
        client,
        args.intent as unknown as SignedEnvelope<unknown, number>,
      );
      for (const listing of args.prepared.listings) {
        if (listing.reused) continue;
        await client.query(
          `INSERT INTO standard_service_listings
            (listing_id,registration_id,listing_key,skill_id,skill_contract_hash,
             payment_required,accepting_new_orders,deployment_required,
             splitter_address,preparation_json,control_profile_json,state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PREPARED')`,
          [
            listing.listingId,
            args.prepared.registrationId,
            bytes(listing.listingKey),
            listing.skillId,
            bytes(listing.skillContractHash),
            listing.paymentRequired,
            listing.acceptingNewOrders,
            listing.deploymentRequired,
            listing.splitterAddress?.toLowerCase() ?? null,
            listing.preparation,
            listing.controlProfile,
          ],
        );
        if (listing.preparation) {
          await persistArtifact(
            client,
            listing.preparation as unknown as SignedEnvelope<unknown, number>,
            listing.preparation.payload.listingEpoch,
          );
        }
        if (listing.controlProfile) {
          await persistArtifact(
            client,
            listing.controlProfile as unknown as SignedEnvelope<unknown, number>,
          );
        }
      }
      await client.query("COMMIT");
      return { record: mapRow(row), created: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordEvidencePending(args: {
    registrationId: string;
    evidence: ProviderServiceRegistrationEvidenceEnvelope;
  }): Promise<StoredRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RegistrationRow>(
        `UPDATE standard_service_registrations
            SET state='EVIDENCE_PENDING',evidence_nonce=$2,
                canonical_evidence=$3,updated_at=now()
          WHERE registration_id=$1
            AND (
              state='PREPARED'
              OR (state='EVIDENCE_PENDING' AND canonical_evidence=$3::jsonb)
            )
          RETURNING *`,
        [
          args.registrationId,
          bytes(args.evidence.payload.evidenceNonce),
          args.evidence,
        ],
      );
      if (!result.rows[0]) throw new Error("REGISTRATION_STATE_CONFLICT");
      for (const splitter of args.evidence.payload.splitterTransactionHashes) {
        const updated = await client.query(
          `UPDATE standard_service_listings
              SET splitter_transaction_hash=$2,updated_at=now()
            WHERE registration_id=$1 AND listing_id=$3
              AND deployment_required`,
          [
            args.registrationId,
            splitter.transactionHash.toLowerCase(),
            splitter.listingId,
          ],
        );
        if (updated.rowCount !== 1) throw new Error("EVIDENCE_LISTING_MISMATCH");
      }
      await persistArtifact(
        client,
        args.evidence as unknown as SignedEnvelope<unknown, number>,
      );
      await client.query("COMMIT");
      return mapRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectPending(
    registrationId: string,
    code: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE standard_service_registrations
            SET state='REJECTED',registration_healthy=false,chain_active=false,
                last_refresh_error_code=$2,updated_at=now()
          WHERE registration_id=$1
            AND state IN ('PREPARED','EVIDENCE_PENDING')`,
        [registrationId, code.slice(0, 128)],
      );
      if (result.rowCount === 1) {
        await client.query(
          `UPDATE standard_service_listings
              SET state='REJECTED',updated_at=now()
            WHERE registration_id=$1 AND state='PREPARED'`,
          [registrationId],
        );
      }
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async activate(registrationId: string): Promise<StoredRegistration> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const selected = await client.query<RegistrationRow>(
        "SELECT * FROM standard_service_registrations WHERE registration_id=$1 FOR UPDATE",
        [registrationId],
      );
      const current = selected.rows[0];
      if (!current) throw new Error("REGISTRATION_STATE_CONFLICT");
      if (current.state === "ACTIVE") {
        await client.query("COMMIT");
        return mapRow(current);
      }
      if (current.state !== "EVIDENCE_PENDING") {
        throw new Error("REGISTRATION_STATE_CONFLICT");
      }
      await client.query(
        `UPDATE standard_service_registrations
            SET state='SUPERSEDED',marketplace_enabled=false,
                registration_healthy=false,chain_active=false,updated_at=now()
          WHERE service_id=$1 AND state='ACTIVE' AND registration_id<>$2`,
        [current.service_id, registrationId],
      );
      await client.query(
        `UPDATE standard_service_listings
            SET state='ACTIVE',updated_at=now()
          WHERE registration_id=$1`,
        [registrationId],
      );
      const result = await client.query<RegistrationRow>(
        `UPDATE standard_service_registrations
            SET state='ACTIVE',chain_active=true,registration_healthy=true,
                activated_at=COALESCE(activated_at,now()),
                last_refreshed_at=COALESCE(last_refreshed_at,now()),
                last_refresh_attempted_at=now(),updated_at=now()
          WHERE registration_id=$1 AND state='EVIDENCE_PENDING'
          RETURNING *`,
        [registrationId],
      );
      if (!result.rows[0]) throw new Error("REGISTRATION_STATE_CONFLICT");
      await client.query("COMMIT");
      return mapRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setVisibility(
    registrationId: string,
    visible: boolean,
    actor: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE standard_service_registrations
          SET marketplace_enabled=$2,marketplace_enabled_by=$3,
              marketplace_enabled_at=now(),updated_at=now()
        WHERE registration_id=$1 AND state='ACTIVE'`,
      [registrationId, visible, actor.slice(0, 128)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  getPublicByServiceId(serviceId: `0x${string}`): Promise<StoredRegistration | null> {
    return selectOne(
      this.pool,
      `SELECT * FROM standard_service_registrations
        WHERE service_id=$1 AND state='ACTIVE' AND marketplace_enabled
          AND card_accepting_orders AND chain_active AND registration_healthy
          AND last_refreshed_at >= now() - interval '24 hours'`,
      [bytes(serviceId)],
    );
  }

  async listPublic(limit: number): Promise<StoredRegistration[]> {
    const result = await this.pool.query<RegistrationRow>(
      `SELECT * FROM standard_service_registrations
        WHERE state='ACTIVE' AND marketplace_enabled AND card_accepting_orders
          AND chain_active AND registration_healthy
          AND last_refreshed_at >= now() - interval '24 hours'
        ORDER BY activated_at DESC,registration_id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  async listRefreshCandidates(limit: number): Promise<StoredRegistration[]> {
    const result = await this.pool.query<RegistrationRow>(
      `SELECT * FROM standard_service_registrations
        WHERE state='ACTIVE'
        ORDER BY last_refresh_attempted_at NULLS FIRST
        LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  async refreshed(args: {
    registrationId: string;
    card: ProviderServiceCard;
    cardHash: `0x${string}`;
    chainActive: boolean;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE standard_service_registrations
          SET card_json=$2,card_hash=$3,skill_contract_set_hash=$4,
              card_accepting_orders=$5,chain_active=$6,registration_healthy=true,
              refresh_failures=0,last_refresh_error_code=NULL,
              last_refresh_attempted_at=now(),last_refreshed_at=now(),
              updated_at=now()
        WHERE registration_id=$1 AND state='ACTIVE'`,
      [
        args.registrationId,
        args.card,
        bytes(args.cardHash),
        bytes(args.card.skillContractSetHash),
        args.card.service.acceptingNewOrders,
        args.chainActive,
      ],
    );
  }

  async stopNewCommerce(
    registrationId: string,
    code: string,
    chainActive: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE standard_service_registrations
          SET registration_healthy=false,chain_active=$3,
              last_refresh_error_code=$2,last_refresh_attempted_at=now(),updated_at=now()
        WHERE registration_id=$1 AND state='ACTIVE'`,
      [registrationId, code.slice(0, 128), chainActive],
    );
  }

  async refreshFailed(registrationId: string, code: string): Promise<void> {
    await this.pool.query(
      `UPDATE standard_service_registrations
          SET refresh_failures=refresh_failures+1,last_refresh_error_code=$2,
              last_refresh_attempted_at=now(),updated_at=now()
        WHERE registration_id=$1 AND state='ACTIVE'`,
      [registrationId, code.slice(0, 128)],
    );
  }
}
