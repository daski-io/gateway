import type { Pool } from "../db/pool.js";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import type { Hex } from "../types.js";
import { createBazaarRefundDue, transitionBazaarExposure } from "./refundAccounting.js";
import type { VerifiedBazaarFulfillmentAttestation } from "./fulfillmentAttestation.js";
import type { BazaarFulfillmentWorkItem } from "./fulfillmentLeaseStore.js";

interface RawRefundBinding {
  order_record_id: Buffer;
  authorization_digest: Buffer;
  provider_agent_id: string;
  payer: Buffer;
  token: Buffer;
  gross_amount: string;
}

export async function completeBazaarFulfillment(input: {
  pool: Pool;
  work: BazaarFulfillmentWorkItem;
  attestation: VerifiedBazaarFulfillmentAttestation;
}): Promise<boolean> {
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query(
      `UPDATE bazaar_fulfillment_jobs
          SET state = 'complete', lease_token = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE order_record_id = $1 AND state = 'working'
          AND lease_token = $2 AND lease_expires_at > now()`,
      [hexToBytea(input.work.orderRecordId), input.work.leaseToken],
    );
    if (job.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const outcome = input.attestation.outcome;
    const fulfilled = outcome === "FULFILLED";
    const order = await client.query<RawRefundBinding>(
      `UPDATE bazaar_orders
          SET state = $3, failure_code = $4, updated_at = now()
        WHERE order_record_id = $1 AND state = 'dispatched'
          AND task_id_hash = $2
        RETURNING order_record_id, authorization_digest, provider_agent_id,
                  payer, token, gross_amount`,
      [
        hexToBytea(input.work.orderRecordId), hexToBytea(input.work.taskIdHash),
        fulfilled ? "fulfilled" : "fulfillment_refund_due",
        fulfilled ? null : "provider_attested_terminal_failure",
      ],
    );
    const row = order.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO bazaar_fulfillment_attestations (
         order_record_id, evidence_id, attestation_digest, outcome,
         evidence_hash, signature
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.order_record_id, hexToBytea(input.attestation.evidenceId),
        hexToBytea(input.attestation.attestationDigest), outcome,
        hexToBytea(input.attestation.evidenceHash),
        hexToBytea(input.attestation.signature),
      ],
    );
    if (outcome === "FULFILLED") {
      await transitionBazaarExposure(
        client,
        input.work.orderRecordId,
        "paid_unfulfilled",
        "released",
      );
    } else {
      await createBazaarRefundDue({
        client,
        order: toRefundBinding(row),
        reason: outcome,
        evidenceHash: input.attestation.attestationDigest,
      });
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function toRefundBinding(row: RawRefundBinding): {
  orderRecordId: Hex;
  authorizationDigest: Hex;
  providerAgentId: bigint;
  payer: Hex;
  token: Hex;
  grossAmount: bigint;
} {
  const hex = (value: Buffer) => `0x${value.toString("hex")}` as Hex;
  return {
    orderRecordId: hex(row.order_record_id),
    authorizationDigest: hex(row.authorization_digest),
    providerAgentId: BigInt(row.provider_agent_id),
    payer: hex(row.payer), token: hex(row.token),
    grossAmount: BigInt(row.gross_amount),
  };
}
