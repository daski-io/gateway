import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import { assertTransition } from "./stateMachine.js";
import type { StandardAttachmentRef, StandardOrderRecord, StandardOrderState } from "./types.js";
import type { SignedEnvelope, StandardListing, StandardRailManifest } from "./types.js";
import { canonicalHash } from "./canonical.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer | null): Hex | null =>
  value ? (`0x${value.toString("hex")}` as Hex) : null;

interface OrderRow {
  order_id: string;
  order_handle: string;
  handle_hash: Buffer;
  state: StandardOrderState;
  provider_agent_id: string;
  outcome_id: string;
  binding_profile: "stock-fixed-v1" | "recipe-bound-v1";
  listing_manifest_hash: Buffer;
  provider_offer_hash: Buffer;
  canonical_listing: StandardListing;
  quote_hash: Buffer;
  canonical_quote: SignedEnvelope<import("./types.js").QuoteV1>;
  canonical_request_hash: Buffer;
  canonical_request: unknown;
  attachment_set_hash: Buffer | null;
  order_nonce: Buffer;
  authorization_key: Buffer | null;
  payment_payload_hash: Buffer | null;
  payer: Hex | null;
  gross_amount: string;
  provider_net_amount: string | null;
  daski_commission_amount: string | null;
  encrypted_payment_payload: Buffer | null;
  settlement_tx_hash: Hex | null;
  deposit_evidence_hash: Buffer | null;
  release_tx_hash: Hex | null;
  release_evidence_hash: Buffer | null;
  provider_task_id: string | null;
  runtime_epoch: string;
  rail_epoch: string;
  version: string;
  lease_fence: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

function record(row: OrderRow): StandardOrderRecord {
  return {
    orderId: row.order_id,
    handleHash: row.handle_hash,
    state: row.state,
    providerAgentId: row.provider_agent_id,
    outcomeId: row.outcome_id,
    bindingProfile: row.binding_profile,
    listingManifestHash: hex(row.listing_manifest_hash)!,
    providerOfferHash: hex(row.provider_offer_hash)!,
    listing: row.canonical_listing,
    quoteHash: hex(row.quote_hash)!,
    quote: row.canonical_quote,
    canonicalRequestHash: hex(row.canonical_request_hash)!,
    canonicalRequest: row.canonical_request,
    attachmentSetHash: hex(row.attachment_set_hash),
    orderNonce: hex(row.order_nonce)!,
    authorizationKey: hex(row.authorization_key),
    paymentPayloadHash: hex(row.payment_payload_hash),
    payer: row.payer,
    grossAmount: row.gross_amount,
    providerNetAmount: row.provider_net_amount,
    daskiCommissionAmount: row.daski_commission_amount,
    encryptedPaymentPayload: row.encrypted_payment_payload,
    settlementTxHash: row.settlement_tx_hash,
    depositEvidenceHash: hex(row.deposit_evidence_hash),
    releaseTxHash: row.release_tx_hash,
    releaseEvidenceHash: hex(row.release_evidence_hash),
    providerTaskId: row.provider_task_id,
    runtimeEpoch: row.runtime_epoch,
    railEpoch: row.rail_epoch,
    version: Number(row.version),
    leaseFence: Number(row.lease_fence),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDraftInput {
  providerAgentId: string;
  outcomeId: string;
  bindingProfile: string;
  listingManifestHash: Hex;
  providerOfferHash: Hex;
  listing: StandardListing;
  quoteHash: Hex;
  quote: SignedEnvelope<import("./types.js").QuoteV1>;
  orderNonce: Hex;
  canonicalRequestHash: Hex;
  canonicalRequest: unknown;
  grossAmount: string;
  runtimeEpoch: string;
  railEpoch: string;
  listingEpoch: string;
  expiresAt: Date;
  uploadCapability?: string;
  attachments: StandardAttachmentRef[];
  gatewayAudience: string;
}

export class StandardRailStore {
  constructor(private readonly pool: Pool) {}

  async loadReceipt(orderId: string): Promise<SignedEnvelope<Record<string, unknown>> | null> {
    const result = await this.pool.query<{ canonical_receipt: SignedEnvelope<Record<string, unknown>> }>(
      "SELECT canonical_receipt FROM standard_rail_receipts WHERE order_id=$1",
      [orderId],
    );
    return result.rows[0]?.canonical_receipt ?? null;
  }

  async persistReceipt(
    orderId: string,
    receipt: SignedEnvelope<Record<string, unknown>>,
  ): Promise<SignedEnvelope<Record<string, unknown>>> {
    const hash = canonicalHash(receipt);
    await this.pool.query(
      `INSERT INTO standard_rail_receipts(order_id,receipt_hash,canonical_receipt)
       VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING`,
      [orderId, bytes(hash), receipt],
    );
    const stored = await this.loadReceipt(orderId);
    if (!stored) throw new Error("STANDARD_RECEIPT_PERSISTENCE_FAILED");
    return stored;
  }

  async withListingSettlementLock<T>(listingManifestHash: Hex, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `standard:settlement:${listingManifestHash.toLowerCase()}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockName]);
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]).catch(() => undefined);
      client.release();
    }
  }

  async assertActiveEpochs(args: { railProfileHash: Hex; runtimeProfileHash: Hex }): Promise<void> {
    await this.assertActiveEpochsWithQuery(this.pool, args);
  }

  async withRuntimeFence<T>(args: {
    environment: string;
    chainId: number;
    railProfileHash: Hex;
    runtimeProfileHash: Hex;
  }, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `standard-rail:${args.environment}:${args.chainId}`;
    try {
      await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [lockName]);
      await this.assertActiveEpochsWithQuery(client, args);
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [lockName])
        .catch(() => undefined);
      client.release();
    }
  }

  private async assertActiveEpochsWithQuery(
    queryable: Pick<Pool, "query">,
    args: { railProfileHash: Hex; runtimeProfileHash: Hex },
  ): Promise<void> {
    const result = await queryable.query<{
      artifact_type: string;
      artifact_hash: Buffer;
      recovery_valid_before: Date | null;
    }>(
      `SELECT DISTINCT ON (artifact_type) artifact_type,artifact_hash,recovery_valid_before
         FROM standard_rail_artifacts
        WHERE artifact_type IN ('ActiveRailProfileV1','RuntimeReleaseManifestV1')
        ORDER BY artifact_type,epoch DESC,admitted_at DESC`,
    );
    const active = new Map(result.rows.map((row) => [
      row.artifact_type,
      `0x${row.artifact_hash.toString("hex")}`.toLowerCase(),
    ]));
    if (
      active.get("ActiveRailProfileV1") !== args.railProfileHash.toLowerCase() ||
      active.get("RuntimeReleaseManifestV1") !== args.runtimeProfileHash.toLowerCase()
    ) throw new Error("STANDARD_RAIL_RUNTIME_FENCE_LOST");
    if (result.rows.some(
      (row) => !row.recovery_valid_before || row.recovery_valid_before.getTime() <= Date.now(),
    )) {
      throw new Error("STANDARD_RAIL_RECOVERY_APPROVAL_EXPIRED");
    }
  }

  async listingSettlementAvailable(listingManifestHash: Hex, orderId: string): Promise<boolean> {
    const result = await this.pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM standard_orders
          WHERE listing_manifest_hash=$1 AND order_id<>$2
            AND state IN ('SETTLE_INVOKED','FACILITATOR_CONFIRMED','SETTLEMENT_AMBIGUOUS',
                          'SETTLEMENT_FAILED','EXTERNAL_OR_UNPROVEN_DEPOSIT','DEPOSIT_FINAL')
            OR (listing_manifest_hash=$1 AND order_id<>$2 AND state='LEGAL_HOLD'
                AND authorization_key IS NOT NULL AND release_evidence_hash IS NULL)
       ) AS blocked`,
      [bytes(listingManifestHash), orderId],
    );
    return result.rows[0]?.blocked !== true;
  }

  async findByAuthorizationKey(authorizationKey: Hex): Promise<{
    order: StandardOrderRecord;
    handle: string;
  } | null> {
    const result = await this.pool.query<OrderRow>(
      "SELECT * FROM standard_orders WHERE authorization_key=$1",
      [bytes(authorizationKey)],
    );
    return result.rows[0]
      ? { order: record(result.rows[0]), handle: result.rows[0].order_handle }
      : null;
  }

  async admitManifest(manifest: StandardRailManifest): Promise<void> {
    const rail = manifest.activeRailProfile;
    const runtime = manifest.runtimeRelease;
    const artifacts: Array<{ envelope: SignedEnvelope<unknown>; epoch: string | null; recovery: number | null }> = [
      {
        envelope: manifest.facilitatorProfile,
        epoch: manifest.facilitatorProfile.payload.profileEpoch,
        recovery: manifest.facilitatorProfile.payload.recoveryValidBefore,
      },
      {
        envelope: manifest.facilitatorCredentialBinding,
        epoch: manifest.facilitatorCredentialBinding.payload.credentialEpoch,
        recovery: manifest.facilitatorCredentialBinding.payload.recoveryValidBefore,
      },
      { envelope: manifest.railCapabilityRequirements, epoch: null, recovery: rail.payload.recoveryValidBefore },
      { envelope: rail, epoch: rail.payload.railEpoch, recovery: rail.payload.recoveryValidBefore },
      { envelope: manifest.chainEvidencePolicy, epoch: null, recovery: rail.payload.recoveryValidBefore },
      { envelope: runtime, epoch: runtime.payload.runtimeEpoch, recovery: runtime.payload.recoveryValidBefore },
      ...manifest.listings.flatMap((listing) => [
        { envelope: listing.commitment as SignedEnvelope<unknown>, epoch: listing.commitment.payload.listingEpoch, recovery: null },
        { envelope: listing.manifest as SignedEnvelope<unknown>, epoch: listing.commitment.payload.listingEpoch, recovery: null },
        { envelope: listing.offer as SignedEnvelope<unknown>, epoch: listing.commitment.payload.listingEpoch, recovery: null },
        { envelope: listing.providerControlProfile as SignedEnvelope<unknown>, epoch: listing.commitment.payload.listingEpoch, recovery: null },
      ]),
    ];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `standard-rail:${rail.environment}:${rail.chainId}`,
      ]);
      const previous = await client.query<{ artifact_hash: Buffer; epoch: string }>(
        `SELECT artifact_hash,epoch FROM standard_rail_artifacts
         WHERE artifact_type='ActiveRailProfileV1' AND environment=$1 AND chain_id=$2
         ORDER BY epoch DESC LIMIT 1`,
        [rail.environment, rail.chainId],
      );
      if (previous.rows[0] && BigInt(rail.payload.railEpoch) < BigInt(previous.rows[0].epoch)) {
        throw new Error("ACTIVE_RAIL_EPOCH_ROLLBACK");
      }
      const railHash = canonicalHash(rail);
      if (
        !previous.rows[0] &&
        (rail.payload.priorRailEpoch !== "0" || rail.payload.priorActiveRailProfileHash.toLowerCase() !== `0x${"00".repeat(32)}`)
      ) throw new Error("ACTIVE_RAIL_INITIAL_PREDECESSOR_INVALID");
      if (
        previous.rows[0] && BigInt(rail.payload.railEpoch) === BigInt(previous.rows[0].epoch) &&
        railHash.toLowerCase() !== `0x${previous.rows[0].artifact_hash.toString("hex")}`
      ) throw new Error("ACTIVE_RAIL_EPOCH_EQUIVOCATION");
      if (
        previous.rows[0] && BigInt(rail.payload.railEpoch) > BigInt(previous.rows[0].epoch) &&
        (rail.payload.priorRailEpoch !== previous.rows[0].epoch ||
          rail.payload.priorActiveRailProfileHash.toLowerCase() !== `0x${previous.rows[0].artifact_hash.toString("hex")}`)
      ) throw new Error("ACTIVE_RAIL_EPOCH_CHAIN_BROKEN");
      const profile = manifest.facilitatorProfile;
      const previousProfile = await client.query<{ artifact_hash: Buffer; epoch: string }>(
        `SELECT artifact_hash,epoch FROM standard_rail_artifacts
         WHERE artifact_type='FacilitatorProfileV1' AND environment=$1 AND chain_id=$2
         ORDER BY epoch DESC LIMIT 1`,
        [profile.environment, profile.chainId],
      );
      if (
        previousProfile.rows[0] &&
        BigInt(profile.payload.profileEpoch) < BigInt(previousProfile.rows[0].epoch)
      ) throw new Error("FACILITATOR_PROFILE_EPOCH_ROLLBACK");
      if (
        previousProfile.rows[0] &&
        BigInt(profile.payload.profileEpoch) === BigInt(previousProfile.rows[0].epoch) &&
        canonicalHash(profile).toLowerCase() !== `0x${previousProfile.rows[0].artifact_hash.toString("hex")}`
      ) throw new Error("FACILITATOR_PROFILE_EPOCH_EQUIVOCATION");
      const credential = manifest.facilitatorCredentialBinding;
      const previousCredential = await client.query<{ artifact_hash: Buffer; epoch: string }>(
        `SELECT artifact_hash,epoch FROM standard_rail_artifacts
         WHERE artifact_type='FacilitatorCredentialBindingV1' AND environment=$1 AND chain_id=$2
         ORDER BY epoch DESC LIMIT 1`,
        [credential.environment, credential.chainId],
      );
      const credentialHash = canonicalHash(credential);
      if (
        previousCredential.rows[0] &&
        BigInt(credential.payload.credentialEpoch) < BigInt(previousCredential.rows[0].epoch)
      ) throw new Error("FACILITATOR_CREDENTIAL_EPOCH_ROLLBACK");
      if (
        !previousCredential.rows[0] &&
        credential.payload.priorCredentialBindingHash.toLowerCase() !== `0x${"00".repeat(32)}`
      ) throw new Error("FACILITATOR_CREDENTIAL_INITIAL_PREDECESSOR_INVALID");
      if (
        previousCredential.rows[0] &&
        BigInt(credential.payload.credentialEpoch) === BigInt(previousCredential.rows[0].epoch) &&
        credentialHash.toLowerCase() !== `0x${previousCredential.rows[0].artifact_hash.toString("hex")}`
      ) throw new Error("FACILITATOR_CREDENTIAL_EPOCH_EQUIVOCATION");
      if (
        previousCredential.rows[0] &&
        BigInt(credential.payload.credentialEpoch) > BigInt(previousCredential.rows[0].epoch) &&
        credential.payload.priorCredentialBindingHash.toLowerCase() !==
          `0x${previousCredential.rows[0].artifact_hash.toString("hex")}`
      ) throw new Error("FACILITATOR_CREDENTIAL_EPOCH_CHAIN_BROKEN");
      const previousRuntime = await client.query<{ artifact_hash: Buffer; epoch: string }>(
        `SELECT artifact_hash,epoch FROM standard_rail_artifacts
         WHERE artifact_type='RuntimeReleaseManifestV1' AND environment=$1 AND chain_id=$2
         ORDER BY epoch DESC LIMIT 1`,
        [runtime.environment, runtime.chainId],
      );
      if (
        previousRuntime.rows[0] &&
        BigInt(runtime.payload.runtimeEpoch) < BigInt(previousRuntime.rows[0].epoch)
      ) throw new Error("RUNTIME_EPOCH_ROLLBACK");
      if (
        previousRuntime.rows[0] &&
        BigInt(runtime.payload.runtimeEpoch) === BigInt(previousRuntime.rows[0].epoch) &&
        canonicalHash(runtime).toLowerCase() !== `0x${previousRuntime.rows[0].artifact_hash.toString("hex")}`
      ) throw new Error("RUNTIME_EPOCH_EQUIVOCATION");
      for (const listing of manifest.listings) {
        const current = listing.commitment;
        const previousListing = await client.query<{ artifact_hash: Buffer; epoch: string }>(
          `SELECT artifact_hash,epoch FROM standard_rail_artifacts
           WHERE artifact_type='ListingCommitmentV1' AND environment=$1 AND chain_id=$2
             AND canonical_json->'payload'->>'providerAgentId'=$3
             AND canonical_json->'payload'->>'outcomeId'=$4
           ORDER BY epoch DESC LIMIT 1`,
          [current.environment, current.chainId, current.payload.providerAgentId, current.payload.outcomeId],
        );
        const prior = previousListing.rows[0];
        if (prior && BigInt(current.payload.listingEpoch) < BigInt(prior.epoch)) {
          throw new Error("LISTING_EPOCH_ROLLBACK");
        }
        if (
          prior && BigInt(current.payload.listingEpoch) === BigInt(prior.epoch) &&
          canonicalHash(current).toLowerCase() !== `0x${prior.artifact_hash.toString("hex")}`
        ) throw new Error("LISTING_EPOCH_EQUIVOCATION");
      }
      for (const artifact of artifacts) {
        const artifactHash = canonicalHash(artifact.envelope);
        await client.query(
          `INSERT INTO standard_rail_artifacts
            (artifact_hash,artifact_type,schema_version,environment,chain_id,epoch,canonical_json,valid_before,recovery_valid_before)
           VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9) END)
           ON CONFLICT (artifact_hash) DO NOTHING`,
          [
            bytes(artifactHash), artifact.envelope.artifactType, artifact.envelope.schemaVersion,
            artifact.envelope.environment, artifact.envelope.chainId, artifact.epoch,
            artifact.envelope, artifact.envelope.validBefore, artifact.recovery,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createDraft(input: CreateDraftInput): Promise<{ order: StandardOrderRecord; handle: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const existing = await client.query<OrderRow>(
        `SELECT * FROM standard_orders
          WHERE provider_agent_id=$1 AND outcome_id=$2
            AND canonical_request_hash=$3 AND state IN ('DRAFT','CHALLENGE_ISSUED')
            AND listing_manifest_hash=$4 AND provider_offer_hash=$5
            AND runtime_epoch=$6 AND rail_epoch=$7
            AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [
          input.providerAgentId, input.outcomeId, bytes(input.canonicalRequestHash),
          bytes(input.listingManifestHash), bytes(input.providerOfferHash),
          input.runtimeEpoch, input.railEpoch,
        ],
      );
      if (existing.rows[0]) {
        if (input.attachments.length > 0) {
          if (!input.uploadCapability || !/^[A-Za-z0-9_-]{32,128}$/.test(input.uploadCapability)) {
            throw new Error("UPLOAD_CAPABILITY_REQUIRED");
          }
          const session = await client.query(
            `SELECT 1 FROM standard_upload_sessions
              WHERE session_hash=$1 AND bound_order_id=$2 AND consumed_at IS NOT NULL`,
            [createHash("sha256").update(input.uploadCapability).digest(), existing.rows[0].order_id],
          );
          if (session.rowCount !== 1) throw new Error("UPLOAD_CAPABILITY_DOES_NOT_BIND_DRAFT");
        } else if (input.uploadCapability) {
          throw new Error("UPLOAD_CAPABILITY_WITHOUT_ATTACHMENTS");
        }
        await client.query("COMMIT");
        return { order: record(existing.rows[0]), handle: existing.rows[0].order_handle };
      }
      const handle = randomBytes(32).toString("base64url");
      const handleHash = createHash("sha256").update(handle).digest();
      const orderId = `ord_${randomUUID()}`;
      const inserted = await client.query<OrderRow>(
        `INSERT INTO standard_orders (
          order_id,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
          listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
          canonical_request,attachment_set_hash,order_nonce,gross_amount,runtime_epoch,rail_epoch,
          listing_epoch,expires_at)
         VALUES ($1,$2,$3,'CHALLENGE_ISSUED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          orderId, handle, handleHash, input.providerAgentId, input.outcomeId,
          input.bindingProfile, bytes(input.listingManifestHash),
          bytes(input.providerOfferHash), input.listing, bytes(input.quoteHash), input.quote,
          bytes(input.canonicalRequestHash), input.canonicalRequest,
          input.attachments.length > 0 ? bytes(canonicalHash(input.attachments)) : null,
          bytes(input.orderNonce), input.grossAmount, input.runtimeEpoch, input.railEpoch,
          input.listingEpoch, input.expiresAt,
        ],
      );
      if (input.attachments.length > 0) {
        if (!input.uploadCapability || !/^[A-Za-z0-9_-]{32,128}$/.test(input.uploadCapability)) {
          throw new Error("UPLOAD_CAPABILITY_REQUIRED");
        }
        const sessionHash = createHash("sha256").update(input.uploadCapability).digest();
        const session = await client.query<{
          audience: string; bound_order_id: string | null; consumed_at: Date | null;
          expires_at: Date; canonical_request_hash: Buffer | null;
        }>(
          "SELECT * FROM standard_upload_sessions WHERE session_hash=$1 FOR UPDATE",
          [sessionHash],
        );
        const found = session.rows[0];
        if (
          !found || found.audience !== input.gatewayAudience || found.bound_order_id ||
          found.consumed_at || found.expires_at <= new Date()
        ) throw new Error("UPLOAD_CAPABILITY_INVALID_OR_CONSUMED");
        const objects = await client.query<{
          object_id: string; content_hash: Buffer; media_type: string; byte_size: string; expires_at: Date;
        }>(
          `SELECT object_id,content_hash,media_type,byte_size::text,expires_at
           FROM standard_upload_objects WHERE session_hash=$1 ORDER BY object_id`,
          [sessionHash],
        );
        const actual = objects.rows.map((item) => ({
          objectId: item.object_id,
          contentHash: `0x${item.content_hash.toString("hex")}`,
          byteSize: Number(item.byte_size),
          mediaType: item.media_type,
          expiresAt: Math.floor(item.expires_at.getTime() / 1_000),
        })).sort((left, right) => left.objectId.localeCompare(right.objectId));
        const expected = [...input.attachments].sort((left, right) => left.objectId.localeCompare(right.objectId));
        if (canonicalHash(actual) !== canonicalHash(expected)) throw new Error("ATTACHMENT_SET_MISMATCH");
        await client.query(
          `UPDATE standard_upload_sessions SET bound_order_id=$2,canonical_request_hash=$3,consumed_at=now()
           WHERE session_hash=$1`,
          [sessionHash, orderId, bytes(input.canonicalRequestHash)],
        );
      } else if (input.uploadCapability) {
        throw new Error("UPLOAD_CAPABILITY_WITHOUT_ATTACHMENTS");
      }
      await client.query(
        `INSERT INTO standard_order_transitions
          (order_id,from_state,to_state,reason_code,fence)
         VALUES ($1,'DRAFT','CHALLENGE_ISSUED','challenge_issued',0)`,
        [orderId],
      );
      await client.query("COMMIT");
      return { order: record(inserted.rows[0]!), handle };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findByHandle(handle: string): Promise<StandardOrderRecord | null> {
    const handleHash = createHash("sha256").update(handle).digest();
    const result = await this.pool.query<OrderRow>(
      "SELECT * FROM standard_orders WHERE handle_hash=$1",
      [handleHash],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async findById(orderId: string): Promise<StandardOrderRecord | null> {
    const result = await this.pool.query<OrderRow>(
      "SELECT * FROM standard_orders WHERE order_id=$1",
      [orderId],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  async leaseRecoverable(
    workerId: string,
    leaseSeconds: number,
    excludedOrderIds: readonly string[] = [],
  ): Promise<StandardOrderRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidate = await client.query<OrderRow>(
        `SELECT * FROM standard_orders
         WHERE state = ANY($1::text[])
           AND (lease_until IS NULL OR lease_until < now())
           AND updated_at < now() - interval '30 seconds'
           AND NOT (order_id = ANY($2::text[]))
         ORDER BY updated_at ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [[
          "CHALLENGE_ISSUED", "ATTEMPT_OPENED", "VERIFIED", "VERIFY_REJECTED",
          "SETTLE_INVOKED", "FACILITATOR_CONFIRMED", "SETTLEMENT_AMBIGUOUS",
          "SETTLEMENT_FAILED", "EXTERNAL_OR_UNPROVEN_DEPOSIT", "DEPOSIT_FINAL", "RELEASE_FINAL", "DISPATCH_STARTED",
          "DISPATCHED", "DISPATCH_AMBIGUOUS", "FULFILLED", "PROVIDER_FAILED", "KYC_REQUIRED",
          "REFUND_DUE", "REFUND_RESERVED", "REFUND_INVOKED", "REFUND_AMBIGUOUS",
        ], excludedOrderIds],
      );
      if (!candidate.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const leased = await client.query<OrderRow>(
        `UPDATE standard_orders SET lease_owner=$2,
           lease_until=now()+($3::text || ' seconds')::interval,
           lease_fence=lease_fence+1
         WHERE order_id=$1 RETURNING *`,
        [candidate.rows[0].order_id, workerId, leaseSeconds],
      );
      await client.query("COMMIT");
      return record(leased.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseLease(orderId: string, workerId: string, fence: number): Promise<void> {
    await this.pool.query(
      `UPDATE standard_orders SET lease_owner=NULL,lease_until=NULL
       WHERE order_id=$1 AND lease_owner=$2 AND lease_fence=$3`,
      [orderId, workerId, fence],
    );
  }

  async findOpenDraft(
    providerAgentId: string,
    outcomeId: string,
    requestHash: Hex,
    listingManifestHash: Hex,
    providerOfferHash: Hex,
    runtimeEpoch: string,
    railEpoch: string,
  ): Promise<{ order: StandardOrderRecord; handle: string } | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM standard_orders
        WHERE provider_agent_id=$1 AND outcome_id=$2 AND canonical_request_hash=$3
          AND listing_manifest_hash=$4 AND provider_offer_hash=$5
          AND runtime_epoch=$6 AND rail_epoch=$7
          AND state='CHALLENGE_ISSUED' AND expires_at>now()
        ORDER BY created_at DESC LIMIT 1`,
      [
        providerAgentId, outcomeId, bytes(requestHash), bytes(listingManifestHash),
        bytes(providerOfferHash), runtimeEpoch, railEpoch,
      ],
    );
    return result.rows[0]
      ? { order: record(result.rows[0]), handle: result.rows[0].order_handle }
      : null;
  }

  async claimAuthorization(args: {
    orderId: string;
    expectedVersion: number;
    authorizationKey: Hex;
    payer: Hex;
    encryptedPayload: Buffer;
    paymentPayloadHash: Hex;
    facilitatorProfileHash: Hex;
    capacityLimit: number;
  }): Promise<StandardOrderRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const conflict = await client.query<{ order_id: string }>(
        "SELECT order_id FROM standard_orders WHERE authorization_key=$1 FOR UPDATE",
        [bytes(args.authorizationKey)],
      );
      if (conflict.rows[0] && conflict.rows[0].order_id !== args.orderId) {
        throw new Error("PAYMENT_AUTHORIZATION_ALREADY_CLAIMED");
      }
      const target = await client.query<{ listing_manifest_hash: Buffer }>(
        "SELECT listing_manifest_hash FROM standard_orders WHERE order_id=$1 FOR UPDATE",
        [args.orderId],
      );
      if (!target.rows[0]) throw new Error("ORDER_NOT_FOUND");
      const listingHash = target.rows[0].listing_manifest_hash;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `capacity:${listingHash.toString("hex")}`,
      ]);
      const capacity = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM standard_capacity_reservations WHERE listing_manifest_hash=$1 AND state='open'",
        [listingHash],
      );
      if (BigInt(capacity.rows[0]?.count ?? "0") >= BigInt(args.capacityLimit)) {
        throw new Error("OUTCOME_CAPACITY_EXHAUSTED");
      }
      await client.query(
        `INSERT INTO standard_capacity_reservations(order_id,listing_manifest_hash,state)
         VALUES ($1,$2,'open') ON CONFLICT (order_id) DO NOTHING`,
        [args.orderId, listingHash],
      );
      const result = await client.query<OrderRow>(
        `UPDATE standard_orders SET state='ATTEMPT_OPENED',authorization_key=$1,
           payer=$2,encrypted_payment_payload=$3,payment_payload_hash=$4,version=version+1,updated_at=now()
         WHERE order_id=$5 AND state='CHALLENGE_ISSUED' AND version=$6 AND expires_at>now()
         RETURNING *`,
        [
          bytes(args.authorizationKey), args.payer, args.encryptedPayload,
          bytes(args.paymentPayloadHash), args.orderId, args.expectedVersion,
        ],
      );
      if (!result.rows[0]) throw new Error("ORDER_ADMISSION_CONFLICT");
      await client.query(
        `INSERT INTO standard_settlement_attempts
          (order_id,attempt_id,facilitator_profile_hash)
         VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING`,
        [args.orderId, `attempt_${randomUUID()}`, bytes(args.facilitatorProfileHash)],
      );
      await client.query(
        `INSERT INTO standard_order_transitions
          (order_id,from_state,to_state,reason_code,fence)
         VALUES ($1,'CHALLENGE_ISSUED','ATTEMPT_OPENED','authorization_claimed',0)`,
        [args.orderId],
      );
      await client.query("COMMIT");
      return record(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transition(
    order: StandardOrderRecord,
    to: StandardOrderState,
    reason: string,
    changes: Record<string, unknown> = {},
  ): Promise<StandardOrderRecord> {
    assertTransition(order.state, to);
    const allowed = new Map<string, string>([
      ["settlementTxHash", "settlement_tx_hash"],
      ["depositEvidenceHash", "deposit_evidence_hash"],
      ["releaseTxHash", "release_tx_hash"],
      ["releaseEvidenceHash", "release_evidence_hash"],
      ["providerTaskId", "provider_task_id"],
      ["providerNetAmount", "provider_net_amount"],
      ["daskiCommissionAmount", "daski_commission_amount"],
      ["encryptedPaymentPayload", "encrypted_payment_payload"],
    ]);
    const values: unknown[] = [to];
    const sets = [
      "state=$1", "version=version+1", "updated_at=now()",
      "lease_owner=NULL", "lease_until=NULL",
    ];
    for (const [key, value] of Object.entries(changes)) {
      const column = allowed.get(key);
      if (!column) throw new Error(`Unsupported order update ${key}`);
      values.push(key.endsWith("EvidenceHash") && typeof value === "string" ? bytes(value as Hex) : value);
      sets.push(`${column}=$${values.length}`);
    }
    values.push(order.orderId, order.version, order.state, order.leaseFence);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<OrderRow>(
        `UPDATE standard_orders SET ${sets.join(",")}
         WHERE order_id=$${values.length - 3} AND version=$${values.length - 2}
           AND state=$${values.length - 1} AND lease_fence=$${values.length} RETURNING *`,
        values,
      );
      if (!result.rows[0]) throw new Error("ORDER_TRANSITION_CONFLICT");
      await client.query(
        `INSERT INTO standard_order_transitions
          (order_id,from_state,to_state,reason_code,fence)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.orderId, order.state, to, reason, result.rows[0].lease_fence],
      );
      await client.query("COMMIT");
      return record(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseCapacity(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE standard_capacity_reservations SET state='released',released_at=now()
       WHERE order_id=$1 AND state='open'`,
      [orderId],
    );
  }
}
