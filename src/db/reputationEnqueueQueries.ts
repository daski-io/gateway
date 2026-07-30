import type { Hex } from "../types.js";
import type { Pool } from "./pool.js";
import {
  reputationBytea,
  type ReputationMirrorDbRow,
} from "./reputationRows.js";

interface EnqueueRow extends ReputationMirrorDbRow {
  revoke_status: string | null;
  revoke_kind: string | null;
  revoke_data: Record<string, unknown> | null;
  give_status: string | null;
  give_kind: string | null;
  give_data: Record<string, unknown> | null;
}

export class ReputationJournalIntegrityError extends Error {
  constructor() {
    super("reputation mirror and facilitator journal bindings disagree");
    this.name = "ReputationJournalIntegrityError";
  }
}

export function createReputationEnqueueQueries(pool: Pool) {
  return {
    async enqueueReputationMirror(input: {
      paymentId: bigint;
      confirmation: "Confirmed" | "NotConfirmed";
      attestationUid: Hex;
      refUid: Hex | null;
    }): Promise<boolean> {
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`daski:reputation:${input.paymentId}`],
        );
        const result = await client.query<EnqueueRow>(
          `SELECT mirror.*,
                  revoke.status AS revoke_status,
                  revoke.operation_kind AS revoke_kind,
                  revoke.operation_data AS revoke_data,
                  give_tx.status AS give_status,
                  give_tx.operation_kind AS give_kind,
                  give_tx.operation_data AS give_data
             FROM reputation_mirrors AS mirror
             LEFT JOIN facilitator_transactions AS revoke
               ON revoke.id = mirror.revoke_facilitator_transaction_id
             LEFT JOIN facilitator_transactions AS give_tx
               ON give_tx.id = mirror.give_facilitator_transaction_id
            WHERE mirror.payment_id = $1
            FOR UPDATE OF mirror`,
          [input.paymentId.toString()],
        );
        const existing = result.rows[0];
        if (!existing) {
          await client.query(
            `INSERT INTO reputation_mirrors
               (payment_id, attestation_uid, confirmation, ref_uid, status)
             VALUES ($1, $2, $3, $4, 'queued')`,
            values(input),
          );
          await client.query("COMMIT");
          transactionOpen = false;
          return true;
        }

        const invalidLinks = invalidActiveLinks(existing);
        if (invalidLinks.length > 0) {
          await client.query(
            `UPDATE facilitator_transactions
                SET failure_code = 'reputation_journal_mirror_mismatch',
                    updated_at = now()
              WHERE id = ANY($1::uuid[])
                AND status IN ('prepared', 'broadcast')`,
            [invalidLinks],
          );
          await client.query("COMMIT");
          transactionOpen = false;
          throw new ReputationJournalIntegrityError();
        }
        const active =
          isActive(existing.revoke_status) || isActive(existing.give_status);
        if (active) {
          await stagePendingRevision(client, existing, input);
          await client.query("COMMIT");
          transactionOpen = false;
          return false;
        }

        const sameAttestation =
          hex(existing.attestation_uid) === input.attestationUid.toLowerCase();
        if (
          sameAttestation &&
          (existing.status === "sent" || existing.status === "skipped")
        ) {
          await client.query("COMMIT");
          transactionOpen = false;
          return false;
        }
        await client.query(
          `UPDATE reputation_mirrors
              SET attestation_uid = $2,
                  confirmation = $3,
                  ref_uid = $4,
                  status = 'queued',
                  tx_hash = CASE
                    WHEN attestation_uid = $2 THEN tx_hash
                    ELSE NULL
                  END,
                  attempts = 0,
                  next_attempt_at = now(),
                  last_error = NULL,
                  revoke_facilitator_transaction_id = NULL,
                  give_facilitator_transaction_id = NULL,
                  pending_attestation_uid = NULL,
                  pending_confirmation = NULL,
                  pending_ref_uid = NULL,
                  updated_at = now()
            WHERE payment_id = $1`,
          values(input),
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK").catch(() => undefined);
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function invalidActiveLinks(row: EnqueueRow): string[] {
  const invalid: string[] = [];
  if (
    row.revoke_facilitator_transaction_id &&
    isActive(row.revoke_status) &&
    !validLink(row, "feedback_revoke", row.revoke_kind, row.revoke_data)
  ) {
    invalid.push(row.revoke_facilitator_transaction_id);
  }
  if (
    row.give_facilitator_transaction_id &&
    isActive(row.give_status) &&
    !validLink(row, "feedback_give", row.give_kind, row.give_data)
  ) {
    invalid.push(row.give_facilitator_transaction_id);
  }
  return invalid;
}

function validLink(
  row: EnqueueRow,
  kind: string,
  actualKind: string | null,
  data: Record<string, unknown> | null,
): boolean {
  return (
    actualKind === kind &&
    data?.paymentId === row.payment_id &&
    typeof data.attestationUid === "string" &&
    data.attestationUid.toLowerCase() === hex(row.attestation_uid)
  );
}

async function stagePendingRevision(
  client: import("pg").PoolClient,
  row: EnqueueRow,
  input: {
    paymentId: bigint;
    confirmation: "Confirmed" | "NotConfirmed";
    attestationUid: Hex;
    refUid: Hex | null;
  },
): Promise<void> {
  if (
    hex(row.attestation_uid) === input.attestationUid.toLowerCase() ||
    (row.pending_attestation_uid &&
      hex(row.pending_attestation_uid) === input.attestationUid.toLowerCase())
  ) {
    return;
  }
  await client.query(
    `UPDATE reputation_mirrors
        SET pending_attestation_uid = $2,
            pending_confirmation = $3,
            pending_ref_uid = $4,
            updated_at = now()
      WHERE payment_id = $1`,
    values(input),
  );
}

function values(input: {
  paymentId: bigint;
  confirmation: "Confirmed" | "NotConfirmed";
  attestationUid: Hex;
  refUid: Hex | null;
}) {
  return [
    input.paymentId.toString(),
    reputationBytea(input.attestationUid),
    input.confirmation,
    input.refUid ? reputationBytea(input.refUid) : null,
  ];
}

function isActive(status: string | null): boolean {
  return status === "prepared" || status === "broadcast";
}

function hex(value: Buffer): string {
  return `0x${value.toString("hex")}`.toLowerCase();
}
