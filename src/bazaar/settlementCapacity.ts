import type { Pool, PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import type { BazaarSettlementCapacityPolicy } from "./types.js";

const MAX_OUTSTANDING_EXPOSURES = 50;

interface CapacityCounts {
  global_concurrent: string;
  provider_concurrent: string;
  listing_concurrent: string;
  payer_concurrent: string;
  global_rate: string;
  provider_rate: string;
  listing_rate: string;
  payer_rate: string;
}

export function validateSettlementCapacityPolicy(
  policy: BazaarSettlementCapacityPolicy,
): void {
  const concurrent = [
    policy.maxGlobalConcurrent,
    policy.maxPerProviderConcurrent,
    policy.maxPerListingConcurrent,
    policy.maxPerPayerConcurrent,
  ];
  const rates = [
    policy.maxGlobalPerMinute,
    policy.maxPerProviderPerMinute,
    policy.maxPerListingPerMinute,
    policy.maxPerPayerPerMinute,
  ];
  if (
    concurrent.some((value) => !Number.isSafeInteger(value) || value < 1 ||
      value > MAX_OUTSTANDING_EXPOSURES) ||
    rates.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 10_000) ||
    policy.maxPerProviderConcurrent > policy.maxGlobalConcurrent ||
    policy.maxPerListingConcurrent > policy.maxPerProviderConcurrent ||
    policy.maxPerPayerConcurrent > policy.maxPerListingConcurrent ||
    policy.maxPerProviderPerMinute > policy.maxGlobalPerMinute ||
    policy.maxPerListingPerMinute > policy.maxPerProviderPerMinute ||
    policy.maxPerPayerPerMinute > policy.maxPerListingPerMinute
  ) throw new Error("Bazaar settlement capacity policy is invalid");
}

export async function settlementCapacityAvailable(input: {
  queryable: Pool | PoolClient;
  policy: BazaarSettlementCapacityPolicy;
  providerAgentId: bigint;
  listingCommitment: Hex;
  payer: Hex;
}): Promise<boolean> {
  const result = await input.queryable.query<CapacityCounts>(
    `SELECT
       (SELECT count(*) FROM bazaar_exposures
         WHERE state <> 'released') AS global_concurrent,
       (SELECT count(*) FROM bazaar_exposures
         WHERE state <> 'released' AND provider_agent_id = $1
       ) AS provider_concurrent,
       (SELECT count(*) FROM bazaar_exposures e
         JOIN bazaar_orders o USING (order_record_id)
         WHERE e.state <> 'released' AND o.listing_commitment = $2
       ) AS listing_concurrent,
       (SELECT count(*) FROM bazaar_exposures
         WHERE state <> 'released' AND payer = $3
       ) AS payer_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute') AS global_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND provider_agent_id = $1
       ) AS provider_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND listing_commitment = $2
       ) AS listing_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND payer = $3
       ) AS payer_rate`,
    [
      input.providerAgentId.toString(),
      hexToBytea(input.listingCommitment),
      hexToBytea(input.payer),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Bazaar settlement capacity query returned no row");
  return BigInt(row.global_concurrent) < BigInt(input.policy.maxGlobalConcurrent) &&
    BigInt(row.provider_concurrent) < BigInt(input.policy.maxPerProviderConcurrent) &&
    BigInt(row.listing_concurrent) < BigInt(input.policy.maxPerListingConcurrent) &&
    BigInt(row.payer_concurrent) < BigInt(input.policy.maxPerPayerConcurrent) &&
    BigInt(row.global_rate) < BigInt(input.policy.maxGlobalPerMinute) &&
    BigInt(row.provider_rate) < BigInt(input.policy.maxPerProviderPerMinute) &&
    BigInt(row.listing_rate) < BigInt(input.policy.maxPerListingPerMinute) &&
    BigInt(row.payer_rate) < BigInt(input.policy.maxPerPayerPerMinute);
}

export async function listingSettlementCapacityAvailable(input: {
  queryable: Pool;
  policy: BazaarSettlementCapacityPolicy;
  providerAgentId: bigint;
  listingCommitment: Hex;
}): Promise<boolean> {
  const result = await input.queryable.query<Pick<
    CapacityCounts,
    "global_concurrent" | "provider_concurrent" | "listing_concurrent" |
    "global_rate" | "provider_rate" | "listing_rate"
  >>(
    `SELECT
       (SELECT count(*) FROM bazaar_exposures
         WHERE state <> 'released') AS global_concurrent,
       (SELECT count(*) FROM bazaar_exposures
         WHERE state <> 'released' AND provider_agent_id = $1
       ) AS provider_concurrent,
       (SELECT count(*) FROM bazaar_exposures e
         JOIN bazaar_orders o USING (order_record_id)
         WHERE e.state <> 'released' AND o.listing_commitment = $2
       ) AS listing_concurrent,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute') AS global_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND provider_agent_id = $1
       ) AS provider_rate,
       (SELECT count(*) FROM bazaar_orders
         WHERE created_at > now() - interval '1 minute' AND listing_commitment = $2
       ) AS listing_rate`,
    [input.providerAgentId.toString(), hexToBytea(input.listingCommitment)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Bazaar settlement capacity query returned no row");
  return BigInt(row.global_concurrent) < BigInt(input.policy.maxGlobalConcurrent) &&
    BigInt(row.provider_concurrent) < BigInt(input.policy.maxPerProviderConcurrent) &&
    BigInt(row.listing_concurrent) < BigInt(input.policy.maxPerListingConcurrent) &&
    BigInt(row.global_rate) < BigInt(input.policy.maxGlobalPerMinute) &&
    BigInt(row.provider_rate) < BigInt(input.policy.maxPerProviderPerMinute) &&
    BigInt(row.listing_rate) < BigInt(input.policy.maxPerListingPerMinute);
}
