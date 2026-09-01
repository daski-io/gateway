import { createHash, randomBytes, randomUUID } from "node:crypto";
import { keccak256, toBytes } from "viem";
import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import { assertTransition, isTerminalState } from "./stateMachine.js";
import type {
  StandardOrderRecord,
  StandardOrderState,
  StandardRailReceiptV2,
} from "./types.js";
import type { SignedEnvelope, StandardListing, StandardRailManifest } from "./types.js";
import { canonicalHash } from "./canonical.js";
import { parseStandardRailReceiptV2 } from "./wireContracts.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");
const hex = (value: Buffer | null): Hex | null =>
  value ? (`0x${value.toString("hex")}` as Hex) : null;

export const RECOVERABLE_ORDER_STATES = [
  "CHALLENGE_ISSUED", "ATTEMPT_OPENED", "VERIFIED", "VERIFY_REJECTED",
  "SETTLE_INVOKED", "FACILITATOR_CONFIRMED", "SETTLEMENT_AMBIGUOUS",
  "SETTLEMENT_FAILED", "EXTERNAL_OR_UNPROVEN_DEPOSIT", "DEPOSIT_FINAL",
  "RELEASE_FINAL", "DISPATCH_STARTED", "DISPATCHED", "DISPATCH_AMBIGUOUS",
  "INPUT_REQUIRED",
] as const satisfies readonly StandardOrderState[];

interface OrderRow {
  order_id: string;
  order_key: Buffer;
  order_handle: string;
  handle_hash: Buffer;
  state: StandardOrderState;
  provider_agent_id: string;
  outcome_id: string;
  binding_profile: "stock-fixed-v1" | "recipe-bound-v1" | "recipe-bound-v2";
  listing_manifest_hash: Buffer;
  provider_offer_hash: Buffer;
  canonical_listing: StandardListing;
  quote_hash: Buffer;
  canonical_quote: SignedEnvelope<import("./types.js").QuoteV1>;
  canonical_request_hash: Buffer;
  canonical_request: unknown;
  order_nonce: Buffer;
  intent_id: string;
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
  rail_epoch: string;
  capability_epoch: string;
  version: string;
  lease_fence: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

function record(row: OrderRow): StandardOrderRecord {
  return {
    orderId: row.order_id,
    orderKey: hex(row.order_key)!,
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
    orderNonce: hex(row.order_nonce)!,
    intentId: row.intent_id,
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
    railEpoch: row.rail_epoch,
    capabilityEpoch: Number(row.capability_epoch),
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
  intentId: string;
  canonicalRequestHash: Hex;
  canonicalRequest: unknown;
  grossAmount: string;
  railEpoch: string;
  listingEpoch: string;
  expiresAt: Date;
}

export class StandardRailStore {
  constructor(private readonly pool: Pool) {}

  async loadReceipt(orderId: string): Promise<SignedEnvelope<StandardRailReceiptV2, 2> | null> {
    const result = await this.pool.query<{ canonical_receipt: unknown }>(
      "SELECT canonical_receipt FROM standard_rail_receipts WHERE order_id=$1",
      [orderId],
    );
    const receipt = result.rows[0]?.canonical_receipt;
    return receipt === undefined ? null : parseStandardRailReceiptV2(receipt);
  }

  async persistReceipt(
    orderId: string,
    receipt: SignedEnvelope<StandardRailReceiptV2, 2>,
  ): Promise<SignedEnvelope<StandardRailReceiptV2, 2>> {
    parseStandardRailReceiptV2(receipt);
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

  async assertActiveRail(railProfileHash: Hex): Promise<void> {
    await this.assertActiveRailWithQuery(this.pool, railProfileHash);
  }

  async withRailFence<T>(args: {
    environment: string;
    chainId: number;
    railProfileHash: Hex;
  }, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const lockName = `standard-rail:${args.environment}:${args.chainId}`;
    try {
      await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [lockName]);
      await this.assertActiveRailWithQuery(client, args.railProfileHash);
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [lockName])
        .catch(() => undefined);
      client.release();
    }
  }

  private async assertActiveRailWithQuery(
    queryable: Pick<Pool, "query">,
    railProfileHash: Hex,
  ): Promise<void> {
    const result = await queryable.query<{ artifact_hash: Buffer }>(
      `SELECT artifact_hash
         FROM standard_rail_artifacts
        WHERE artifact_type='ActiveRailProfileV1'
        ORDER BY epoch DESC,admitted_at DESC LIMIT 1`,
    );
    const active = result.rows[0]?.artifact_hash;
    if (!active || `0x${active.toString("hex")}`.toLowerCase() !== railProfileHash.toLowerCase()) {
      throw new Error("STANDARD_RAIL_PROFILE_FENCE_LOST");
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

  async findByIntentId(intentId: string): Promise<{
    order: StandardOrderRecord;
    handle: string;
  } | null> {
    const result = await this.pool.query<OrderRow>(
      "SELECT * FROM standard_orders WHERE intent_id=$1",
      [intentId],
    );
    return result.rows[0]
      ? { order: record(result.rows[0]), handle: result.rows[0].order_handle }
      : null;
  }

  async admitManifest(manifest: StandardRailManifest): Promise<void> {
    const rail = manifest.activeRailProfile;
    const artifacts: Array<{
      envelope: SignedEnvelope<unknown, number>;
      epoch: string | null;
      recovery: number | null;
    }> = [
      {
        envelope: manifest.facilitatorProfile,
        epoch: manifest.facilitatorProfile.payload.profileEpoch,
        recovery: manifest.facilitatorProfile.payload.recoveryValidBefore,
      },
      { envelope: manifest.railCapabilityRequirements, epoch: null, recovery: null },
      { envelope: rail, epoch: rail.payload.railEpoch, recovery: rail.payload.recoveryValidBefore },
      { envelope: manifest.chainEvidencePolicy, epoch: null, recovery: null },
      ...manifest.servicingAdmissions.map((envelope) => ({ envelope, epoch: null, recovery: null })),
      ...manifest.actionCatalogs.map((envelope) => ({ envelope, epoch: null, recovery: null })),
      ...manifest.providerControlProfiles.map((envelope) => ({
        envelope: envelope as SignedEnvelope<unknown, number>,
        epoch: null,
        recovery: null,
      })),
    ];
    const client = await this.pool.connect();
    try {
      // Read committed under the rail lock: every admission of these artifact
      // types takes this lock before reading the epoch chain, so the checks are
      // already serialized; SERIALIZABLE fixed the snapshot before the lock was
      // granted (see walletStore.issue).
      await client.query("BEGIN");
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
            AND rail_epoch=$6
            AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [
          input.providerAgentId, input.outcomeId, bytes(input.canonicalRequestHash),
          bytes(input.listingManifestHash), bytes(input.providerOfferHash),
          input.railEpoch,
        ],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { order: record(existing.rows[0]), handle: existing.rows[0].order_handle };
      }
      const handle = randomBytes(32).toString("base64url");
      const handleHash = createHash("sha256").update(handle).digest();
      const orderId = `ord_${randomUUID()}`;
      const orderKey = keccak256(toBytes(orderId));
      const inserted = await client.query<OrderRow>(
        `INSERT INTO standard_orders (
          order_id,order_key,order_handle,handle_hash,state,provider_agent_id,outcome_id,binding_profile,
          listing_manifest_hash,provider_offer_hash,canonical_listing,quote_hash,canonical_quote,canonical_request_hash,
          canonical_request,order_nonce,intent_id,gross_amount,rail_epoch,
          listing_epoch,expires_at)
         VALUES ($1,$2,$3,$4,'CHALLENGE_ISSUED',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [
          orderId, bytes(orderKey), handle, handleHash, input.providerAgentId, input.outcomeId,
          input.bindingProfile, bytes(input.listingManifestHash),
          bytes(input.providerOfferHash), input.listing, bytes(input.quoteHash), input.quote,
          bytes(input.canonicalRequestHash), input.canonicalRequest,
          bytes(input.orderNonce), input.intentId, input.grossAmount, input.railEpoch,
          input.listingEpoch, input.expiresAt,
        ],
      );
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

  async bumpCapabilityEpoch(orderId: string): Promise<StandardOrderRecord> {
    const result = await this.pool.query<OrderRow>(
      `UPDATE standard_orders
          SET capability_epoch=capability_epoch+1,updated_at=now()
        WHERE order_id=$1 RETURNING *`,
      [orderId],
    );
    if (!result.rows[0]) throw new Error("ORDER_NOT_FOUND");
    return record(result.rows[0]);
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
        [RECOVERABLE_ORDER_STATES, excludedOrderIds],
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

  // An in-flight driver (the purchase request) leases the order it is
  // advancing so recovery treats the order as attended while, for example, a
  // finality wait runs past the recovery due time. The fence bump fences out
  // any stale holder exactly as a worker lease does. Null when another
  // driver holds a live lease: that driver owns the order now.
  async leaseOrder(
    orderId: string,
    owner: string,
    leaseSeconds: number,
  ): Promise<StandardOrderRecord | null> {
    const result = await this.pool.query<OrderRow>(
      `UPDATE standard_orders SET lease_owner=$2,
         lease_until=now()+($3::text || ' seconds')::interval,
         lease_fence=lease_fence+1
       WHERE order_id=$1 AND (lease_until IS NULL OR lease_until < now())
       RETURNING *`,
      [orderId, owner, leaseSeconds],
    );
    return result.rows[0] ? record(result.rows[0]) : null;
  }

  // Extends a lease the caller still holds. False means the fence moved on:
  // another driver leased the order and this caller must stop advancing it.
  async renewLease(
    orderId: string,
    owner: string,
    fence: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE standard_orders SET lease_until=now()+($4::text || ' seconds')::interval
       WHERE order_id=$1 AND lease_owner=$2 AND lease_fence=$3 AND lease_until>now()`,
      [orderId, owner, fence, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  async findOpenDraft(
    providerAgentId: string,
    outcomeId: string,
    requestHash: Hex,
    listingManifestHash: Hex,
    providerOfferHash: Hex,
    railEpoch: string,
  ): Promise<{ order: StandardOrderRecord; handle: string } | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT * FROM standard_orders
        WHERE provider_agent_id=$1 AND outcome_id=$2 AND canonical_request_hash=$3
          AND listing_manifest_hash=$4 AND provider_offer_hash=$5
          AND rail_epoch=$6
          AND state='CHALLENGE_ISSUED' AND expires_at>now()
        ORDER BY created_at DESC LIMIT 1`,
      [
        providerAgentId, outcomeId, bytes(requestHash), bytes(listingManifestHash),
        bytes(providerOfferHash), railEpoch,
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
    reputationIntent?: {
      kind: "register" | "confirmation";
      logicalKey: Hex;
      intentHash: Hex;
      canonicalIntent: unknown;
    },
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
    // A live lease belongs to the driver performing this transition (the
    // fence the UPDATE checks is the one that lease issued), so it survives
    // the transition and keeps the order attended; an expired lease is
    // cleared. Drivers release their lease explicitly when they stop.
    const sets = [
      "state=$1", "version=version+1", "updated_at=now()",
      "lease_owner=CASE WHEN lease_until>now() THEN lease_owner END",
      "lease_until=CASE WHEN lease_until>now() THEN lease_until END",
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
      if (reputationIntent) {
        await client.query(
          `INSERT INTO standard_reputation_operations
             (order_id,kind,logical_key,intent_hash,canonical_intent,state,next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,'pending',now())
           ON CONFLICT (kind,logical_key) DO NOTHING`,
          [
            order.orderId,
            reputationIntent.kind,
            bytes(reputationIntent.logicalKey),
            bytes(reputationIntent.intentHash),
            reputationIntent.canonicalIntent,
          ],
        );
      }
      if (isTerminalState(to)) {
        await client.query(
          `UPDATE standard_capacity_reservations SET state='released',released_at=now()
           WHERE order_id=$1 AND state='open'`,
          [order.orderId],
        );
      }
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
