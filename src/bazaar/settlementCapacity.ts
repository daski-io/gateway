import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { BazaarSettlementCapacityPolicy } from "./types.js";

const ACTIVE_STATES = [
  "attempt_opened",
  "settle_started",
  "settle_confirmed",
  "settled",
  "dispatch_started",
] as const;

interface CapacityCounts {
  global_concurrent: string;
  listing_concurrent: string;
  payer_concurrent: string;
  global_rate: string;
  listing_rate: string;
  payer_rate: string;
}

export function validateSettlementCapacityPolicy(
  policy: BazaarSettlementCapacityPolicy,
): void {
  const values = Object.values(policy);
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 10_000) ||
    policy.maxPerListingConcurrent > policy.maxGlobalConcurrent ||
    policy.maxPerPayerConcurrent > policy.maxPerListingConcurrent ||
    policy.maxPerListingPerMinute > policy.maxGlobalPerMinute ||
    policy.maxPerPayerPerMinute > policy.maxPerListingPerMinute
  ) throw new Error("Bazaar settlement capacity policy is invalid");
}

export async function settlementCapacityAvailable(input: {
  queryable: Pool | PoolClient;
  policy: BazaarSettlementCapacityPolicy;
  listingCommitment: Hex;
  payer: Hex;
}): Promise<boolean> {
  const result = await input.queryable.query<CapacityCounts>(
    `SELECT
       (SELECT count(*) FROM bazaar_orders
         WHERE state = ANY($1::text[])) AS global_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE state = ANY($1::text[]) AND listing_commitment = $2
       ) AS listing_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE state = ANY($1::text[]) AND payer = $3
       ) AS payer_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute') AS global_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND listing_commitment = $2
       ) AS listing_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND payer = $3
       ) AS payer_rate`,
    [ACTIVE_STATES, hexToBytea(input.listingCommitment), hexToBytea(input.payer)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Bazaar settlement capacity query returned no row");
  return BigInt(row.global_concurrent) < BigInt(input.policy.maxGlobalConcurrent) &&
    BigInt(row.listing_concurrent) < BigInt(input.policy.maxPerListingConcurrent) &&
    BigInt(row.payer_concurrent) < BigInt(input.policy.maxPerPayerConcurrent) &&
    BigInt(row.global_rate) < BigInt(input.policy.maxGlobalPerMinute) &&
    BigInt(row.listing_rate) < BigInt(input.policy.maxPerListingPerMinute) &&
    BigInt(row.payer_rate) < BigInt(input.policy.maxPerPayerPerMinute);
}

export async function listingSettlementCapacityAvailable(input: {
  queryable: Pool;
  policy: BazaarSettlementCapacityPolicy;
  listingCommitment: Hex;
}): Promise<boolean> {
  const result = await input.queryable.query<Pick<
    CapacityCounts,
    "global_concurrent" | "listing_concurrent" | "global_rate" | "listing_rate"
  >>(
    `SELECT
       (SELECT count(*) FROM bazaar_orders
         WHERE state = ANY($1::text[])) AS global_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE state = ANY($1::text[]) AND listing_commitment = $2
       ) AS listing_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute') AS global_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND listing_commitment = $2
       ) AS listing_rate`,
    [ACTIVE_STATES, hexToBytea(input.listingCommitment)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Bazaar settlement capacity query returned no row");
  return BigInt(row.global_concurrent) < BigInt(input.policy.maxGlobalConcurrent) &&
    BigInt(row.listing_concurrent) < BigInt(input.policy.maxPerListingConcurrent) &&
    BigInt(row.global_rate) < BigInt(input.policy.maxGlobalPerMinute) &&
    BigInt(row.listing_rate) < BigInt(input.policy.maxPerListingPerMinute);
}
