import type { Pool } from "../db/pool.js";
import { canonicalHash } from "./canonical.js";
import { operationsSchema, type OrderOperations } from "./operationsSchema.js";

export interface TerminalEvidence {
  payload: Record<string, unknown>;
  signature: string;
}
export interface StoredOperations {
  operations: OrderOperations;
  accumulatedWaitSeconds: number;
  originalTerminal: TerminalEvidence | null;
}

function terminalIdentity(value: TerminalEvidence) {
  const { taskId, state, completedAt, resultHash } = value.payload;
  return { taskId, state, completedAt, resultHash };
}

export async function loadOperations(pool: Pool, orderId: string): Promise<StoredOperations | null> {
  const result = await pool.query<{ safe_projection: OrderOperations; wait_seconds: string; original_terminal: TerminalEvidence | null }>(
    "SELECT safe_projection,wait_seconds,original_terminal FROM standard_order_operations WHERE order_id=$1", [orderId],
  );
  const row = result.rows[0];
  return row ? { operations: operationsSchema.parse(row.safe_projection), accumulatedWaitSeconds: Number(row.wait_seconds),
    originalTerminal: row.original_terminal } : null;
}

/** Called only after outer signature, task binding and terminal signature verification. */
export async function persistOperations(
  pool: Pool, orderId: string, input: unknown, terminal: TerminalEvidence | null,
): Promise<void> {
  const operations = operationsSchema.parse(input);
  const now = Math.floor(Date.now() / 1_000);
  if (operations.observedAt > now + 30 || operations.observedAt < now - 300) {
    throw new Error("provider_operations_observation_stale");
  }
  const { observedAt: _observedAt, ...semantic } = operations;
  const projectionHash = Buffer.from(canonicalHash(semantic).slice(2), "hex");
  // DNS names/values are transient buyer content, never retained in this table.
  const safe = { ...operations, fulfillment: operations.fulfillment
    ? { ...operations.fulfillment, missingRecords: [] } : null };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT order_id FROM standard_orders WHERE order_id=$1 FOR UPDATE", [orderId]);
    const previous = await client.query<{
      revision: string; observed_at: string; projection_hash: Buffer;
      safe_projection: OrderOperations; wait_seconds: string; original_terminal: TerminalEvidence | null;
    }>("SELECT * FROM standard_order_operations WHERE order_id=$1 FOR UPDATE", [orderId]);
    const old = previous.rows[0];
    // One revision names exactly one projection; a different body under a
    // stored revision is provider equivocation, never a benign race.
    if (old && operations.revision === Number(old.revision) && !projectionHash.equals(old.projection_hash)) {
      throw new Error("provider_operations_revision_conflict");
    }
    if (old?.original_terminal && terminal &&
        canonicalHash(terminalIdentity(old.original_terminal)) !== canonicalHash(terminalIdentity(terminal))) {
      throw new Error("provider_original_terminal_changed");
    }
    // Concurrent reads of the same order can arrive out of order. An older
    // observation is valid signed evidence, but it never replaces a newer one.
    if (old && (operations.revision < Number(old.revision) || operations.observedAt < Number(old.observed_at))) {
      await client.query("COMMIT");
      return;
    }
    const original = old?.original_terminal ?? terminal;
    const recovery = operations.recovery;
    if (recovery && (!original || original.payload.state !== "failed" ||
        recovery.originalTerminal.resultHash !== original.payload.resultHash ||
        recovery.originalTerminal.completedAt !== original.payload.completedAt ||
        (recovery.state === "completed" && (!recovery.completedAt || !recovery.resultHash)))) {
      throw new Error("provider_recovery_terminal_binding_invalid");
    }
    if (old && operations.fulfillment &&
        operations.fulfillment.accumulatedWaitSeconds < Number(old.wait_seconds)) {
      throw new Error("provider_wait_clock_regressed");
    }
    await client.query(
      `INSERT INTO standard_order_operations(order_id,revision,observed_at,projection_hash,safe_projection,original_terminal,wait_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id) DO UPDATE SET
       revision=EXCLUDED.revision,observed_at=EXCLUDED.observed_at,projection_hash=EXCLUDED.projection_hash,
       safe_projection=EXCLUDED.safe_projection,original_terminal=COALESCE(standard_order_operations.original_terminal,EXCLUDED.original_terminal),
       wait_seconds=greatest(standard_order_operations.wait_seconds,EXCLUDED.wait_seconds),refreshed_at=now()`,
      [orderId, operations.revision, operations.observedAt, projectionHash, safe, original, operations.fulfillment?.accumulatedWaitSeconds ?? 0],
    );
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export function fulfillmentClock(operations: OrderOperations | null, admitted: boolean,
  now = Math.floor(Date.now() / 1_000), retainedWaitSeconds = 0) {
  const fulfillment = admitted ? operations?.fulfillment : null;
  const waiting = fulfillment?.phase === "dns_pending" || fulfillment?.phase === "waiting_capacity";
  return {
    waiting,
    stale: waiting && (!fulfillment.nextCheckAt || now > fulfillment.nextCheckAt + 300 || now > operations!.observedAt + 600),
    excludedSeconds: Math.max(fulfillment?.accumulatedWaitSeconds ?? 0, admitted ? retainedWaitSeconds : 0),
  };
}
