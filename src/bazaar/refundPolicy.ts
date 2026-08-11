import type { Pool, PoolClient } from "pg";
import type {
  BazaarListing,
  BazaarRefundRiskPolicy,
} from "./types.js";

const MAX_UINT256 = (1n << 256n) - 1n;

interface RiskTotals {
  reserved: string;
  paid_unfulfilled: string;
  refund_due: string;
  blocking_refund: boolean;
}

export function validateRefundRiskPolicies(
  policies: Record<string, BazaarRefundRiskPolicy>,
  listings: BazaarListing[],
): void {
  if (!policies || typeof policies !== "object" || Array.isArray(policies)) {
    throw new Error("Bazaar refund-risk policies are invalid");
  }
  const expected = [...new Set(listings.map((listing) =>
    listing.offer.message.providerAgentId.toString()))].sort();
  const actual = Object.keys(policies).sort();
  if (actual.join("\0") !== expected.join("\0")) {
    throw new Error("Bazaar refund-risk policies do not match listed providers");
  }
  for (const providerId of expected) validateRefundRiskPolicy(policies[providerId]!);
}

export function refundRiskPolicyFor(
  policies: Record<string, BazaarRefundRiskPolicy>,
  providerAgentId: bigint,
): BazaarRefundRiskPolicy {
  const policy = policies[providerAgentId.toString()];
  if (!policy) throw new Error("Bazaar provider has no refund-risk policy");
  return policy;
}

export async function refundRiskHeadroomAvailable(input: {
  queryable: Pool | PoolClient;
  providerAgentId: bigint;
  grossAmount: bigint;
  policy: BazaarRefundRiskPolicy;
}): Promise<boolean> {
  const result = await input.queryable.query<RiskTotals>(
    `SELECT
       COALESCE((SELECT sum(gross_amount) FROM bazaar_exposures
         WHERE provider_agent_id = $1 AND state = 'reserved'), 0) AS reserved,
       COALESCE((SELECT sum(gross_amount) FROM bazaar_exposures
         WHERE provider_agent_id = $1 AND state = 'paid_unfulfilled'), 0)
         AS paid_unfulfilled,
       COALESCE((SELECT sum(gross_amount) FROM bazaar_exposures
         WHERE provider_agent_id = $1 AND state = 'refund_due'), 0) AS refund_due,
       EXISTS(SELECT 1 FROM bazaar_refund_obligations
         WHERE provider_agent_id = $1 AND (
           state = 'blocked_issuer' OR
           (state IN ('due', 'broadcast') AND due_at <= now())
         )) AS blocking_refund`,
    [input.providerAgentId.toString()],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Bazaar refund-risk query returned no row");
  const reserved = BigInt(row.reserved);
  const paid = BigInt(row.paid_unfulfilled);
  const refundDue = BigInt(row.refund_due);
  return !row.blocking_refund && input.grossAmount <= input.policy.maxSingleGross &&
    reserved + input.grossAmount <= input.policy.maxAggregateReserved &&
    reserved + paid + input.grossAmount <=
      input.policy.maxAggregatePaidUnfulfilled &&
    reserved + paid + refundDue + input.grossAmount <=
      input.policy.maxAggregateRefundDue;
}

function validateRefundRiskPolicy(policy: BazaarRefundRiskPolicy): void {
  const caps = [
    policy.maxSingleGross,
    policy.maxAggregateReserved,
    policy.maxAggregatePaidUnfulfilled,
    policy.maxAggregateRefundDue,
  ];
  if (
    !["contractual-only", "prefunded-reserve", "bonded"].includes(policy.assurance) ||
    caps.some((value) => typeof value !== "bigint" || value < 1n || value > MAX_UINT256) ||
    caps.slice(1).some((value) => value < policy.maxSingleGross) ||
    policy.maxAggregateReserved > policy.maxAggregatePaidUnfulfilled ||
    policy.maxAggregatePaidUnfulfilled > policy.maxAggregateRefundDue ||
    !Number.isSafeInteger(policy.refundSlaSeconds) ||
    policy.refundSlaSeconds < 60 || policy.refundSlaSeconds > 30 * 24 * 60 * 60
  ) throw new Error("Bazaar refund-risk policy is invalid");
}
