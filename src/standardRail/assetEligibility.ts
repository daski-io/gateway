import type { Hex } from "viem";
import type { Pool } from "../db/pool.js";

/**
 * Gateway eligibility for a payer's owner-only reads and actions with a
 * provider (spec C1): a post-deposit order by the payer with that provider,
 * OR a provider-signed owner swap naming the payer. The union is additive and
 * anchored to the original order; nothing about that order changes.
 */
const POST_DEPOSIT_STATES = [
  "RELEASE_FINAL", "DISPATCH_STARTED", "DISPATCHED", "DISPATCH_AMBIGUOUS",
  "FULFILLED", "PROVIDER_FAILED", "INPUT_REQUIRED", "LEGAL_HOLD", "NOT_SETTLED",
] as const;

export async function isPayerEligibleForProvider(
  pool: Pick<Pool, "query">,
  payer: Hex,
  providerAgentId: string,
): Promise<boolean> {
  const eligible = await pool.query(
    `SELECT 1 FROM standard_orders WHERE lower(payer)=$1 AND provider_agent_id=$2
        AND state = ANY($3::text[])
     UNION ALL
     SELECT 1 FROM standard_provider_owner_swaps WHERE new_payer=$1 AND provider_agent_id=$2
     LIMIT 1`,
    [payer.toLowerCase(), providerAgentId, [...POST_DEPOSIT_STATES]],
  );
  return eligible.rowCount === 1;
}

export async function eligibleProvidersForPayer(
  pool: Pick<Pool, "query">,
  payer: Hex,
  providerAgentId: string | null,
  limit: number,
): Promise<string[]> {
  const eligible = await pool.query<{ provider_agent_id: string }>(
    `SELECT DISTINCT provider_agent_id FROM (
       SELECT provider_agent_id FROM standard_orders
        WHERE lower(payer)=$1 AND state = ANY($4::text[])
       UNION
       SELECT provider_agent_id FROM standard_provider_owner_swaps WHERE new_payer=$1
     ) eligible
      WHERE ($2::text IS NULL OR provider_agent_id=$2)
      ORDER BY provider_agent_id LIMIT $3`,
    [payer.toLowerCase(), providerAgentId, limit, [...POST_DEPOSIT_STATES]],
  );
  return eligible.rows.map((row) => row.provider_agent_id);
}
