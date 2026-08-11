import {
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import type { PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type {
  BazaarOrder,
  BazaarRefundReason,
  BazaarRefundRiskPolicy,
} from "./types.js";

const REFUND_DOMAIN_HASH = keccak256(toBytes("DASKI_BAZAAR_REFUND_V1"));
const REFUND_EVIDENCE_DOMAIN_HASH = keccak256(
  toBytes("DASKI_BAZAAR_REFUND_EVIDENCE_V1"),
);

interface RawRefundBinding {
  refund_id: Buffer;
  authorization_digest: Buffer;
  provider_agent_id: string;
  payer: Buffer;
  token: Buffer;
  gross_amount: string;
  primary_reason: BazaarRefundReason;
  evidence_hash: Buffer | null;
  refund_wallet: Buffer;
  refund_policy_version: Buffer;
}

interface RawExposurePolicy {
  state: "reserved" | "paid_unfulfilled" | "refund_due" | "released";
  refund_wallet: Buffer;
  refund_policy_version: Buffer;
  refund_sla_seconds: number;
}

export function computeBazaarRefundEvidenceHash(
  order: BazaarRefundBinding,
  reason: BazaarRefundReason,
  failureCode: string,
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      REFUND_EVIDENCE_DOMAIN_HASH,
      order.orderRecordId,
      order.authorizationDigest,
      keccak256(toBytes(reason)),
      keccak256(toBytes(failureCode)),
    ],
  ));
}

export type BazaarRefundBinding = Pick<BazaarOrder,
  "orderRecordId" | "authorizationDigest" | "providerAgentId" |
  "payer" | "token" | "grossAmount">;

export function computeBazaarRefundId(
  order: BazaarRefundBinding,
  reason: BazaarRefundReason,
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes32" },
    ],
    [
      REFUND_DOMAIN_HASH,
      order.orderRecordId,
      order.authorizationDigest,
      order.payer,
      order.grossAmount,
      keccak256(toBytes(reason)),
    ],
  ));
}

export async function reserveBazaarExposure(
  client: PoolClient,
  order: BazaarOrder,
  policy: BazaarRefundRiskPolicy,
  policyVersion: Hex,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO bazaar_exposures (
       order_record_id, authorization_digest, provider_agent_id, payer, token,
       gross_amount, refund_wallet, refund_policy_version, refund_sla_seconds,
       state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved')`,
    [
      hexToBytea(order.orderRecordId), hexToBytea(order.authorizationDigest),
      order.providerAgentId.toString(), hexToBytea(order.payer),
      hexToBytea(order.token), order.grossAmount.toString(),
      hexToBytea(policy.refundWallet), hexToBytea(policyVersion),
      policy.refundSlaSeconds,
    ],
  );
  if (result.rowCount !== 1) throw new Error("Bazaar exposure was not reserved");
}

export async function transitionBazaarExposure(
  client: PoolClient,
  orderRecordId: Hex,
  expected: "reserved" | "paid_unfulfilled" | "refund_due",
  next: "paid_unfulfilled" | "refund_due" | "released",
): Promise<void> {
  const result = await client.query(
    `UPDATE bazaar_exposures SET state = $3, updated_at = now()
      WHERE order_record_id = $1 AND state = $2`,
    [hexToBytea(orderRecordId), expected, next],
  );
  if (result.rowCount !== 1) {
    throw new Error("Bazaar exposure transition violated its expected state");
  }
}

export async function createBazaarRefundDue(input: {
  client: PoolClient;
  order: BazaarRefundBinding;
  reason: BazaarRefundReason;
  evidenceHash: Hex;
  expectedExposure?: "reserved" | "paid_unfulfilled";
}): Promise<void> {
  const { client, order, reason } = input;
  const expectedExposure = input.expectedExposure ?? "paid_unfulfilled";
  const exposure = await client.query<RawExposurePolicy>(
    `SELECT state, refund_wallet, refund_policy_version, refund_sla_seconds
       FROM bazaar_exposures WHERE order_record_id = $1 FOR UPDATE`,
    [hexToBytea(order.orderRecordId)],
  );
  const policy = exposure.rows[0];
  if (
    !policy ||
    (policy.state !== expectedExposure && policy.state !== "refund_due")
  ) throw new Error("Bazaar refund policy snapshot is unavailable");
  const refundId = computeBazaarRefundId(order, reason);
  await client.query(
    `INSERT INTO bazaar_refund_obligations (
       order_record_id, refund_id, authorization_digest, provider_agent_id,
       payer, token, gross_amount, primary_reason, due_at, evidence_hash,
       refund_wallet, refund_policy_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
       now() + make_interval(secs => $9), $10, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      hexToBytea(order.orderRecordId), hexToBytea(refundId),
      hexToBytea(order.authorizationDigest), order.providerAgentId.toString(),
      hexToBytea(order.payer), hexToBytea(order.token),
      order.grossAmount.toString(), reason, policy.refund_sla_seconds,
      hexToBytea(input.evidenceHash), policy.refund_wallet,
      policy.refund_policy_version,
    ],
  );
  const stored = await client.query<RawRefundBinding>(
    `SELECT refund_id, authorization_digest, provider_agent_id, payer, token,
            gross_amount, primary_reason, evidence_hash, refund_wallet,
            refund_policy_version
       FROM bazaar_refund_obligations WHERE order_record_id = $1`,
    [hexToBytea(order.orderRecordId)],
  );
  const row = stored.rows[0];
  if (!row || !refundBindingMatches(
    row,
    order,
    reason,
    refundId,
    input.evidenceHash,
    policy,
  )) {
    throw new Error("Bazaar refund obligation binding conflict");
  }
  await client.query(
    `INSERT INTO bazaar_refund_reason_events (order_record_id, reason)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [hexToBytea(order.orderRecordId), reason],
  );
  await client.query(
    `INSERT INTO bazaar_refund_jobs (order_record_id)
     VALUES ($1) ON CONFLICT DO NOTHING`,
    [hexToBytea(order.orderRecordId)],
  );
  await ensureRefundDueExposure(
    client,
    order.orderRecordId,
    expectedExposure,
  );
}

async function ensureRefundDueExposure(
  client: PoolClient,
  orderRecordId: Hex,
  expected: "reserved" | "paid_unfulfilled",
): Promise<void> {
  const transitioned = await client.query(
    `UPDATE bazaar_exposures SET state = 'refund_due', updated_at = now()
      WHERE order_record_id = $1 AND state = $2`,
    [hexToBytea(orderRecordId), expected],
  );
  if (transitioned.rowCount === 1) return;
  const existing = await client.query<{ state: string }>(
    "SELECT state FROM bazaar_exposures WHERE order_record_id = $1",
    [hexToBytea(orderRecordId)],
  );
  if (existing.rows[0]?.state !== "refund_due") {
    throw new Error("Bazaar refund exposure violated its expected state");
  }
}

function refundBindingMatches(
  row: RawRefundBinding,
  order: BazaarRefundBinding,
  reason: BazaarRefundReason,
  refundId: Hex,
  evidenceHash: Hex,
  policy: RawExposurePolicy,
): boolean {
  const samePrimaryReason = row.primary_reason === reason;
  return (!samePrimaryReason || (
    row.refund_id.equals(hexToBytea(refundId)) &&
    row.evidence_hash !== null &&
    row.evidence_hash.equals(hexToBytea(evidenceHash))
  )) &&
    row.authorization_digest.equals(hexToBytea(order.authorizationDigest)) &&
    row.provider_agent_id === order.providerAgentId.toString() &&
    row.payer.equals(hexToBytea(order.payer)) &&
    row.token.equals(hexToBytea(order.token)) &&
    BigInt(row.gross_amount) === order.grossAmount &&
    row.refund_wallet.equals(policy.refund_wallet) &&
    row.refund_policy_version.equals(policy.refund_policy_version);
}
