import type { Pool, PoolClient } from "pg";
import type {
  BazaarListing,
  BazaarRefundRiskPolicy,
  BazaarRefundWorkerPolicy,
} from "./types.js";
import { encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { isHex32, isHexAddress } from "../util/evmValidation.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const REFUND_POLICY_TYPE_HASH = keccak256(toBytes(
  "DaskiProviderRefundRiskPolicyV1(uint256 providerAgentId,bytes32 assurance,address refundWallet,uint256 maxSingleGross,uint256 maxAggregateReserved,uint256 maxAggregatePaidUnfulfilled,uint256 maxAggregateRefundDue,uint256 refundSlaSeconds)",
));

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
  for (const providerId of expected) {
    const policy = policies[providerId]!;
    const providerAgentId = BigInt(providerId);
    validateRefundRiskPolicy(policy);
    const version = computeBazaarRefundPolicyVersion(providerAgentId, policy);
    for (const listing of listings.filter((candidate) =>
      candidate.offer.message.providerAgentId === providerAgentId)) {
      if (
        !isHex32(listing.policyVersion) ||
        listing.policyVersion.toLowerCase() !== version.toLowerCase() ||
        listing.offer.message.token.toLowerCase() === policy.refundWallet.toLowerCase()
      ) throw new Error("Bazaar listing does not bind its refund-risk policy");
    }
  }
}

export function computeBazaarRefundPolicyVersion(
  providerAgentId: bigint,
  policy: BazaarRefundRiskPolicy,
): Hex {
  if (providerAgentId < 1n || providerAgentId > MAX_UINT256) {
    throw new Error("Bazaar refund-risk provider is invalid");
  }
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" },
      { type: "address" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
    ],
    [
      REFUND_POLICY_TYPE_HASH, providerAgentId,
      keccak256(toBytes(policy.assurance)), policy.refundWallet,
      policy.maxSingleGross, policy.maxAggregateReserved,
      policy.maxAggregatePaidUnfulfilled, policy.maxAggregateRefundDue,
      BigInt(policy.refundSlaSeconds),
    ],
  ));
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
    !isHexAddress(policy.refundWallet) || /^0x0{40}$/i.test(policy.refundWallet) ||
    caps.some((value) => typeof value !== "bigint" || value < 1n || value > MAX_UINT256) ||
    caps.slice(1).some((value) => value < policy.maxSingleGross) ||
    policy.maxAggregateReserved > policy.maxAggregatePaidUnfulfilled ||
    policy.maxAggregatePaidUnfulfilled > policy.maxAggregateRefundDue ||
    !Number.isSafeInteger(policy.refundSlaSeconds) ||
    policy.refundSlaSeconds < 60 || policy.refundSlaSeconds > 30 * 24 * 60 * 60
  ) throw new Error("Bazaar refund-risk policy is invalid");
}

export function validateRefundWorkerPolicy(policy: BazaarRefundWorkerPolicy): void {
  if (
    !policy || typeof policy !== "object" ||
    !Number.isSafeInteger(policy.instructionTtlSeconds) ||
    policy.instructionTtlSeconds < 30 || policy.instructionTtlSeconds > 5 * 60 ||
    !Number.isSafeInteger(policy.retryDelaySeconds) ||
    policy.retryDelaySeconds < 5 || policy.retryDelaySeconds > 60 * 60
  ) throw new Error("Bazaar refund-worker policy is invalid");
}
