import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import type { Config } from "../config.js";
import type { Pool } from "../db/pool.js";
import type { MarketplaceChainReader } from "../marketplace/reader.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import type { SignedEnvelope } from "../standardRail/types.js";
import { logger } from "../util/logger.js";
import { verifyProviderEnvelope } from "./auth.js";
import { RegistrationError } from "./service.js";

export const OWNER_SWAP_ARTIFACT_TYPE = "ProviderOwnerSwapV1";

export interface ProviderOwnerSwapV1 {
  providerAgentId: string;
  providerAssetId: string;
  ownerVersion: number;
  orderId: string;
  orderKey: Hex;
  previousPayer: Hex;
  newPayer: Hex;
}

export type ProviderOwnerSwapEnvelope = SignedEnvelope<ProviderOwnerSwapV1>;

export interface OwnerSwapRecord {
  providerAssetId: string;
  ownerVersion: number;
  newPayer: Hex;
  contentHash: Hex;
  receivedAt: string;
}

const OWNER_SWAP_FIELDS = [
  "providerAgentId", "providerAssetId", "ownerVersion", "orderId", "orderKey",
  "previousPayer", "newPayer",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORDER_ID = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOWERCASE_ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_OWNER_VERSION = 2_147_483_647;

/** The keccak256 of the canonical payload; issuedAt and validBefore are envelope fields. */
export function ownerSwapContentHash(payload: ProviderOwnerSwapV1): Hex {
  return canonicalHash(payload);
}

export function orderKeyOf(orderId: string): Hex {
  return keccak256(toBytes(orderId));
}

/** Closed payload parser; every failure is a fail-closed format refusal. */
export function parseOwnerSwapPayload(value: unknown): ProviderOwnerSwapV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("owner swap payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (keys.length !== OWNER_SWAP_FIELDS.length || keys.some((key) => !(OWNER_SWAP_FIELDS as readonly string[]).includes(key))) {
    throw new Error("owner swap payload fields are invalid");
  }
  const providerAgentId = payload.providerAgentId;
  if (typeof providerAgentId !== "string" || !/^(?:0|[1-9]\d{0,77})$/.test(providerAgentId)) {
    throw new Error("owner swap providerAgentId is invalid");
  }
  const providerAssetId = payload.providerAssetId;
  if (typeof providerAssetId !== "string" || !UUID.test(providerAssetId)) {
    throw new Error("owner swap providerAssetId must be a lowercase UUID");
  }
  const ownerVersion = payload.ownerVersion;
  if (
    typeof ownerVersion !== "number" || !Number.isSafeInteger(ownerVersion) ||
    ownerVersion < 1 || ownerVersion > MAX_OWNER_VERSION
  ) throw new Error("owner swap ownerVersion must be a positive integer");
  const orderId = payload.orderId;
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) {
    throw new Error("owner swap orderId must be a gateway order id");
  }
  const orderKey = payload.orderKey;
  if (typeof orderKey !== "string" || !/^0x[0-9a-f]{64}$/.test(orderKey) || orderKeyOf(orderId) !== orderKey) {
    throw new Error("owner swap orderKey must equal keccak256(orderId)");
  }
  const previousPayer = payload.previousPayer;
  const newPayer = payload.newPayer;
  if (
    typeof previousPayer !== "string" || !LOWERCASE_ADDRESS.test(previousPayer) ||
    typeof newPayer !== "string" || !LOWERCASE_ADDRESS.test(newPayer) || previousPayer === newPayer
  ) throw new Error("owner swap payers must be distinct lowercase addresses");
  return {
    providerAgentId,
    providerAssetId,
    ownerVersion,
    orderId,
    orderKey: orderKey as Hex,
    previousPayer: previousPayer as Hex,
    newPayer: newPayer as Hex,
  };
}

interface SwapRow {
  provider_asset_id: string;
  owner_version: number;
  new_payer: string;
  content_hash: Buffer;
  received_at: Date;
}

function recordOf(row: SwapRow): OwnerSwapRecord {
  return {
    providerAssetId: row.provider_asset_id,
    ownerVersion: Number(row.owner_version),
    newPayer: row.new_payer as Hex,
    contentHash: `0x${row.content_hash.toString("hex")}` as Hex,
    receivedAt: row.received_at.toISOString(),
  };
}

export interface OwnerSwapServiceOptions {
  config: Pick<Config, "chainId" | "publicUrl">;
  railConfig: Pick<StandardRailConfig, "environment" | "ownerSwaps">;
  pool: Pool;
  marketplace: MarketplaceChainReader;
  /** Resolves when the payer is clear; throws SANCTIONS_ADDRESS_REJECTED or an outage. */
  screen: (payer: Address) => Promise<void>;
}

/**
 * POST /v1/owner-swaps (spec C1). The provider tells the gateway that an
 * asset's owner changed; the gateway records the notice and grants
 * (newPayer, provider) eligibility for owner-only reads and actions. It
 * never rewrites an order, receipt, claim, nonce, or reputation row.
 */
export class OwnerSwapService {
  constructor(private readonly options: OwnerSwapServiceOptions) {}

  async submit(raw: unknown): Promise<{ created: boolean; record: OwnerSwapRecord }> {
    const { config, railConfig, pool, marketplace } = this.options;
    if (!railConfig.ownerSwaps.enabled) {
      throw new RegistrationError(403, "OWNER_SWAPS_DISABLED", "Owner swaps are not enabled on this gateway.");
    }
    // Format first, fail closed: the idempotency key and content hash come
    // from the payload alone, so a replay is answered before any signature or
    // chain work, whatever the envelope's age or signing key.
    const envelopeKeys = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>) : null;
    let payload: ProviderOwnerSwapV1;
    try {
      payload = parseOwnerSwapPayload(envelopeKeys?.payload);
    } catch (error) {
      throw new RegistrationError(
        400,
        "OWNER_SWAP_INVALID",
        error instanceof Error ? error.message : "The owner swap payload is invalid.",
      );
    }
    const contentHash = ownerSwapContentHash(payload);
    const existing = await this.find(payload);
    if (existing) return { created: false, record: this.replay(existing, contentHash) };

    let verified;
    try {
      verified = await verifyProviderEnvelope<ProviderOwnerSwapV1>({
        raw,
        artifactType: OWNER_SWAP_ARTIFACT_TYPE,
        parsePayload: parseOwnerSwapPayload,
        providerAgentId: (value) => value.providerAgentId,
        config,
        railConfig,
        marketplace,
      });
    } catch {
      throw new RegistrationError(
        401,
        "OWNER_SWAP_AUTH_INVALID",
        "The signed owner swap or the finalized provider authority is invalid.",
      );
    }
    const order = await pool.query<{ provider_agent_id: string; order_key: Buffer }>(
      "SELECT provider_agent_id,order_key FROM standard_orders WHERE order_id=$1",
      [payload.orderId],
    );
    const row = order.rows[0];
    if (!row) throw new RegistrationError(404, "ORDER_NOT_FOUND", "The referenced order does not exist.");
    if (row.provider_agent_id !== payload.providerAgentId) {
      throw new RegistrationError(409, "ORDER_PROVIDER_MISMATCH", "The order belongs to another provider.");
    }
    if (`0x${row.order_key.toString("hex")}` !== payload.orderKey) {
      throw new RegistrationError(409, "ORDER_KEY_MISMATCH", "The order key does not match the stored order.");
    }
    try {
      await this.options.screen(getAddress(payload.newPayer));
    } catch (error) {
      if (error instanceof Error && error.message === "SANCTIONS_ADDRESS_REJECTED") {
        throw new RegistrationError(403, "NEW_PAYER_SANCTIONED", "The new payer is sanctioned.");
      }
      logger.warn("owner swap screening unavailable", {
        providerAgentId: payload.providerAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new RegistrationError(503, "SCREENING_UNAVAILABLE", "Sanctions screening is unavailable; retry later.");
    }
    const daily = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM standard_provider_owner_swaps
        WHERE provider_agent_id=$1 AND received_at>now()-interval '1 day'`,
      [payload.providerAgentId],
    );
    if (Number(daily.rows[0]?.count ?? "0") >= railConfig.ownerSwaps.perProviderPerDay) {
      throw new RegistrationError(429, "OWNER_SWAP_RATE_LIMITED", "The provider's daily owner swap budget is exhausted.");
    }
    const inserted = await pool.query<SwapRow>(
      `INSERT INTO standard_provider_owner_swaps
        (provider_agent_id,provider_asset_id,owner_version,order_id,previous_payer,new_payer,
         content_hash,canonical_envelope,signer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider_agent_id,provider_asset_id,owner_version) DO NOTHING
       RETURNING provider_asset_id,owner_version,new_payer,content_hash,received_at`,
      [
        payload.providerAgentId, payload.providerAssetId, payload.ownerVersion, payload.orderId,
        payload.previousPayer, payload.newPayer, Buffer.from(contentHash.slice(2), "hex"),
        verified.envelope, verified.signer.toLowerCase(),
      ],
    );
    if (inserted.rows[0]) return { created: true, record: recordOf(inserted.rows[0]) };
    const raced = await this.find(payload);
    if (!raced) throw new Error("owner swap insert lost its row");
    return { created: false, record: this.replay(raced, contentHash) };
  }

  private replay(existing: SwapRow, contentHash: Hex): OwnerSwapRecord {
    const record = recordOf(existing);
    if (record.contentHash !== contentHash) {
      throw new RegistrationError(
        409,
        "OWNER_SWAP_CONFLICT",
        "This asset version was already recorded with a different payload.",
      );
    }
    return record;
  }

  private async find(payload: ProviderOwnerSwapV1): Promise<SwapRow | null> {
    const result = await this.options.pool.query<SwapRow>(
      `SELECT provider_asset_id,owner_version,new_payer,content_hash,received_at
         FROM standard_provider_owner_swaps
        WHERE provider_agent_id=$1 AND provider_asset_id=$2 AND owner_version=$3`,
      [payload.providerAgentId, payload.providerAssetId, payload.ownerVersion],
    );
    return result.rows[0] ?? null;
  }
}
