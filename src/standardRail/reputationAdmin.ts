import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Pool } from "../db/pool.js";
import type { StandardRailConfig } from "./config.js";
import { logger } from "../util/logger.js";

function equalSecret(received: string | undefined, expected: string): boolean {
  const left = createHash("sha256").update(received ?? "").digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function authorize(request: Request, config: StandardRailConfig, csrf: boolean): string {
  const authorization = request.header("authorization");
  const actor = request.header("x-admin-actor");
  if (!authorization?.startsWith("Bearer ") ||
    !equalSecret(authorization.slice(7), config.admin.bearerToken) ||
    (csrf && !equalSecret(request.header("x-csrf-token"), config.admin.csrfToken)) ||
    !actor || !/^[A-Za-z0-9@._-]{1,128}$/.test(actor)) throw new Error("ADMIN_ACCESS_DENIED");
  return actor;
}

const reasonClasses = new Set([
  "rpc_finality",
  "balance_fee",
  "nonce_conflict",
  "contract_rejection",
  "application_fault",
]);

function exactReasonClass(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !("reasonClass" in value) ||
    typeof value.reasonClass !== "string" || !reasonClasses.has(value.reasonClass)) {
    throw new Error("ADMIN_REQUEST_INVALID");
  }
  return value.reasonClass;
}

export function createReputationAdminRouter(pool: Pool, config: StandardRailConfig): Router {
  const router = Router();
  router.get("/admin/reputation/operations", async (req, res) => {
    try {
      authorize(req, config, false);
      const [operations, mirrors] = await Promise.all([
        pool.query(`SELECT operation_id,order_id,kind,state,attempts,retry_once_used,
          last_error_class,next_attempt_at,created_at,updated_at
          FROM standard_reputation_operations ORDER BY updated_at DESC LIMIT 250`),
        pool.query(`SELECT order_id,state,attempts,transaction_count,retry_once_used,last_error_class,
          next_attempt_at,updated_at FROM standard_reputation_mirrors ORDER BY updated_at DESC LIMIT 250`),
      ]);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ operations: operations.rows, mirrors: mirrors.rows });
    } catch { res.status(401).json({ error: { code: "ADMIN_ACCESS_DENIED" } }); }
  });
  router.post("/admin/reputation/operations/:operationId/:action", async (req, res) => {
    try {
      const actor = authorize(req, config, true);
      const reason = exactReasonClass(req.body);
      const action = String(req.params.action);
      if (!['reconcile', 'retry-once', 'abort'].includes(action)) throw new Error("ADMIN_REQUEST_INVALID");
      res.json(await mutateOperation(pool, String(req.params.operationId), action as never, actor, reason));
    } catch (error) {
      const denied = error instanceof Error && error.message === "ADMIN_ACCESS_DENIED";
      res.status(denied ? 401 : 409).json({ error: { code: denied ? "ADMIN_ACCESS_DENIED" : "ADMIN_ACTION_REJECTED" } });
    }
  });
  router.post("/admin/reputation/mirrors/:orderId/:action", async (req, res) => {
    try {
      const actor = authorize(req, config, true);
      const reason = exactReasonClass(req.body);
      const action = String(req.params.action);
      if (!['reconcile', 'retry-once', 'abort'].includes(action)) throw new Error("ADMIN_REQUEST_INVALID");
      res.json(await mutateMirror(pool, String(req.params.orderId), action as never, actor, reason));
    } catch (error) {
      const denied = error instanceof Error && error.message === "ADMIN_ACCESS_DENIED";
      res.status(denied ? 401 : 409).json({ error: { code: denied ? "ADMIN_ACCESS_DENIED" : "ADMIN_ACTION_REJECTED" } });
    }
  });
  return router;
}

async function mutateOperation(pool: Pool, id: string,
  action: "reconcile" | "retry-once" | "abort", actor: string, reason: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ state: string; kind: string; retry_once_used: boolean }>(
      "SELECT state,kind,retry_once_used FROM standard_reputation_operations WHERE operation_id=$1 FOR UPDATE", [id]);
    const row = found.rows[0];
    if (!row || row.state === "final" || row.state.startsWith("aborted") ||
      row.state === "blocked_parent_aborted") throw new Error("ADMIN_ACTION_REJECTED");
    const previous = row.state;
    let next: string;
    if (action === "reconcile") {
      const active = await client.query("SELECT 1 FROM standard_reputation_transactions WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention')", [id]);
      next = active.rowCount ? "broadcast" : "pending";
      await client.query("UPDATE standard_reputation_operations SET state=$2,next_attempt_at=now(),updated_at=now() WHERE operation_id=$1", [id, next]);
    } else if (action === "retry-once") {
      if (row.state !== "operator_attention" || row.retry_once_used) throw new Error("ADMIN_ACTION_REJECTED");
      const ambiguous = await client.query(
        "SELECT 1 FROM standard_reputation_transactions WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention','final')",
        [id],
      );
      if (ambiguous.rowCount) throw new Error("ADMIN_ACTION_REJECTED");
      next = "pending";
      await client.query(`UPDATE standard_reputation_operations SET state='pending',attempts=4,
        retry_once_used=true,next_attempt_at=now(),last_error_class=NULL,updated_at=now() WHERE operation_id=$1`, [id]);
    } else {
      if (row.state !== "operator_attention") throw new Error("ADMIN_ACTION_REJECTED");
      const ambiguous = await client.query("SELECT 1 FROM standard_reputation_transactions WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention','final')", [id]);
      if (ambiguous.rowCount) throw new Error("ADMIN_ACTION_REJECTED");
      next = "aborted_unattested";
      await client.query("UPDATE standard_reputation_operations SET state=$2,next_attempt_at=NULL,updated_at=now() WHERE operation_id=$1", [id, next]);
      await client.query("UPDATE standard_confirmation_sponsorships SET state='released',updated_at=now() WHERE operation_id=$1 AND state='reserved'", [id]);
      if (row.kind === "register") await client.query(
        `UPDATE standard_reputation_operations SET state='blocked_parent_aborted',next_attempt_at=NULL,updated_at=now()
          WHERE order_id=(SELECT order_id FROM standard_reputation_operations WHERE operation_id=$1)
            AND operation_id<>$1 AND state IN ('pending','operator_attention')`, [id]);
    }
    await client.query(`INSERT INTO standard_reputation_admin_audit
      (operation_id,actor,action,reason,previous_state,resulting_state) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, actor, action, reason, previous, next]);
    await client.query("COMMIT");
    if (action === "abort") {
      logger.warn("standard reputation operation aborted unattested", {
        operationId: id,
        actor,
        reasonClass: reason,
      });
    }
    return { operationId: id, state: next };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function mutateMirror(pool: Pool, orderId: string,
  action: "reconcile" | "retry-once" | "abort", actor: string, reason: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ state: string; attempts: number; retry_once_used: boolean }>(
      "SELECT state,attempts,retry_once_used FROM standard_reputation_mirrors WHERE order_id=$1 FOR UPDATE", [orderId]);
    const row = found.rows[0];
    if (!row || row.state === "current" || row.state === "aborted_unmirrored") throw new Error("ADMIN_ACTION_REJECTED");
    const previous = row.state;
    const active = await client.query("SELECT 1 FROM standard_reputation_mirror_transactions WHERE order_id=$1 AND state IN ('prepared','broadcast','operator_attention')", [orderId]);
    if (action === "abort" && (row.state !== "operator_attention" || active.rowCount)) {
      throw new Error("ADMIN_ACTION_REJECTED");
    }
    if (action === "retry-once") {
      if (row.state !== "operator_attention" || row.retry_once_used || active.rowCount) {
        throw new Error("ADMIN_ACTION_REJECTED");
      }
    }
    const next = action === "abort" ? "aborted_unmirrored" : active.rowCount ? "broadcast" : "pending";
    await client.query(`UPDATE standard_reputation_mirrors SET state=$2,
      attempts=CASE WHEN $3='retry-once' THEN 4 ELSE attempts END,
      retry_once_used=CASE WHEN $3='retry-once' THEN true ELSE retry_once_used END,
      next_attempt_at=CASE WHEN $2='aborted_unmirrored' THEN NULL ELSE now() END,
      updated_at=now() WHERE order_id=$1`, [orderId, next, action]);
    await client.query(`INSERT INTO standard_reputation_admin_audit
      (mirror_order_id,actor,action,reason,previous_state,resulting_state) VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, actor, action, reason, previous, next]);
    await client.query("COMMIT");
    if (action === "abort") {
      logger.warn("reputation mirror aborted unmirrored", {
        orderId,
        actor,
        reasonClass: reason,
      });
    }
    return { orderId, state: next };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
