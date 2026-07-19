import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";

interface ReputationMirrorDbRow {
  payment_id: string;
  attestation_uid: Buffer;
  provider_agent_id: string | null;
  feedback_index: string | null;
  tx_hash: Buffer | null;
  status: "sent" | "failed";
  updated_at: Date;
}

export interface ReputationMirrorRow {
  paymentId: bigint;
  attestationUid: Hex;
  providerAgentId: bigint | null;
  feedbackIndex: bigint | null;
  txHash: Hex | null;
  status: "sent" | "failed";
  updatedAt: Date;
}

const bytea = (hex: Hex): Buffer => Buffer.from(hex.slice(2), "hex");
const hex = (value: Buffer): Hex => `0x${value.toString("hex")}` as Hex;

export function createReputationQueries(pool: Pool) {
  return {
    async getReputationMirror(
      paymentId: bigint,
    ): Promise<ReputationMirrorRow | null> {
      const result = await pool.query<ReputationMirrorDbRow>(
        `SELECT * FROM reputation_mirrors WHERE payment_id = $1`,
        [paymentId.toString()],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        paymentId: BigInt(row.payment_id),
        attestationUid: hex(row.attestation_uid),
        providerAgentId:
          row.provider_agent_id != null ? BigInt(row.provider_agent_id) : null,
        feedbackIndex:
          row.feedback_index != null ? BigInt(row.feedback_index) : null,
        txHash: row.tx_hash ? hex(row.tx_hash) : null,
        status: row.status,
        updatedAt: row.updated_at,
      };
    },

    async upsertReputationMirror(row: {
      paymentId: bigint;
      attestationUid: Hex;
      providerAgentId: bigint | null;
      feedbackIndex: bigint | null;
      txHash: Hex | null;
      status: "sent" | "failed";
    }): Promise<void> {
      await pool.query(
        `INSERT INTO reputation_mirrors
           (payment_id, attestation_uid, provider_agent_id, feedback_index,
            tx_hash, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (payment_id) DO UPDATE
         SET attestation_uid = EXCLUDED.attestation_uid,
             provider_agent_id = EXCLUDED.provider_agent_id,
             feedback_index = EXCLUDED.feedback_index,
             tx_hash = EXCLUDED.tx_hash,
             status = EXCLUDED.status,
             updated_at = now()`,
        [
          row.paymentId.toString(),
          bytea(row.attestationUid),
          row.providerAgentId?.toString() ?? null,
          row.feedbackIndex?.toString() ?? null,
          row.txHash ? bytea(row.txHash) : null,
          row.status,
        ],
      );
    },
  };
}
