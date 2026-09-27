import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "../db/pool.js";
import { authorizedOperator } from "../serviceRegistration/routes.js";
import { assertTransition } from "./stateMachine.js";

export class OperatorConflict extends Error {}

/** Operator changes and their audit records commit together. */
export class StandardRailOperator {
  constructor(private readonly pool: Pool) {}

  async redispatch(orderId: string): Promise<{ orderId: string; state: "RELEASE_FINAL"; claimId: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        state: string; provider_task_id: string | null; busy: boolean;
      }>(`SELECT state,provider_task_id,lease_until>now() AS busy
            FROM standard_orders WHERE order_id=$1 FOR UPDATE`, [orderId]);
      const order = result.rows[0];
      if (!order) throw new OperatorConflict("order_not_found");
      if (order.state !== "PROVIDER_FAILED") throw new OperatorConflict("order_not_provider_failed");
      if (order.provider_task_id !== null) throw new OperatorConflict("provider_task_already_assigned");
      if (order.busy) throw new OperatorConflict("order_driver_active");
      const evidence = await client.query(
        "SELECT 1 FROM standard_chain_evidence WHERE order_id=$1 AND evidence_kind='release'", [orderId],
      );
      if (!evidence.rowCount) throw new OperatorConflict("release_evidence_missing");
      const claims = await client.query<{
        invocation_state: string; resolved_at: Date | null; provider_task_id: string | null;
      }>("SELECT * FROM standard_dispatch_claims WHERE order_id=$1 FOR UPDATE", [orderId]);
      const claim = claims.rows[0];
      if (claim && (claim.invocation_state !== "invoked" || claim.resolved_at || claim.provider_task_id !== null)) {
        throw new OperatorConflict("dispatch_claim_resolved");
      }
      assertTransition("PROVIDER_FAILED", "RELEASE_FINAL");
      const claimId = randomUUID();
      await client.query(
        `INSERT INTO standard_operator_actions (actor,action,target_id,details)
         VALUES ('catalog-operator','operator_redispatch',$1,$2)`,
        [orderId, JSON.stringify({ claimId, previousClaim: claim ?? null })],
      );
      // An explicit revival starts a new fulfillment window. The original
      // release evidence stays immutable; the old signed claim is audited.
      await client.query(
        `INSERT INTO standard_dispatch_recovery (order_id,claim_id,started_at)
         VALUES ($1,$2,now()) ON CONFLICT (order_id) DO UPDATE
           SET claim_id=$2,started_at=now(),retry_pending=false,refusals=0,next_attempt_at=now()`,
        [orderId, claimId],
      );
      await client.query("DELETE FROM standard_dispatch_claims WHERE order_id=$1", [orderId]);
      const changed = await client.query<{ lease_fence: string }>(
        `UPDATE standard_orders SET state='RELEASE_FINAL',version=version+1,
           lease_fence=lease_fence+1,lease_owner=NULL,lease_until=NULL,updated_at=now()
         WHERE order_id=$1 RETURNING lease_fence`, [orderId],
      );
      await client.query(
        `INSERT INTO standard_order_transitions (order_id,from_state,to_state,reason_code,fence)
         VALUES ($1,'PROVIDER_FAILED','RELEASE_FINAL','operator_redispatch',$2)`,
        [orderId, changed.rows[0]!.lease_fence],
      );
      await client.query("COMMIT");
      return { orderId, state: "RELEASE_FINAL", claimId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async retryReputation(operationId: string): Promise<{ operationId: string; state: "pending" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ state: string; last_error_class: string | null }>(
        "SELECT state,last_error_class FROM standard_reputation_operations WHERE operation_id=$1 FOR UPDATE", [operationId],
      );
      const operation = result.rows[0];
      if (!operation) throw new OperatorConflict("operation_not_found");
      if (operation.state !== "pending" &&
          !(operation.state === "operator_attention" && operation.last_error_class === "nonce_conflict")) {
        throw new OperatorConflict(`operation_not_retryable:${operation.state}`);
      }
      const transactions = await client.query<{ transaction_id: string; state: string }>(
        `SELECT transaction_id,state FROM standard_reputation_transactions
          WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention','final') FOR UPDATE`,
        [operationId],
      );
      if (transactions.rows.some((tx) => ["broadcast", "final"].includes(tx.state))) {
        throw new OperatorConflict("transaction_broadcast_or_final");
      }
      if (operation.state === "operator_attention") {
        // nonce_conflict is recorded only after the worker observes the nonce
        // consumed at finality and finds no receipt for this transaction.
        await client.query(
          `UPDATE standard_reputation_transactions SET state='failed',updated_at=now()
            WHERE operation_id=$1 AND state IN ('prepared','operator_attention')`, [operationId],
        );
      }
      await client.query(
        `UPDATE standard_reputation_operations SET state='pending',next_attempt_at=now(),updated_at=now(),
           attempts=CASE WHEN state='operator_attention' THEN 0 ELSE attempts END
         WHERE operation_id=$1`, [operationId],
      );
      await client.query(
        `INSERT INTO standard_operator_actions (actor,action,target_id,details)
         VALUES ('catalog-operator','operator_reputation_retry',$1,$2)`,
        [operationId, JSON.stringify({ previousState: operation.state, reason: operation.last_error_class, transactions: transactions.rows })],
      );
      await client.query("COMMIT");
      return { operationId, state: "pending" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

export function createStandardOperatorRouter(operator: StandardRailOperator, token: string): Router {
  const router = Router();
  const paths = [
    ["/operator/v1/orders/:id/redispatch", (id: string) => operator.redispatch(id)],
    ["/operator/v1/reputation/:id/retry", (id: string) => operator.retryReputation(id)],
  ] as const;
  for (const [path, action] of paths) {
    router.post(path, (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      if (!authorizedOperator(req, token)) {
        res.status(401).json({ error: { code: "OPERATOR_AUTH_REQUIRED", message: "Operator authentication is required." } });
        return;
      }
      const id = req.params.id;
      const valid = typeof id === "string" && (path.includes("/orders/")
        ? /^ord_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
      if (!valid) { res.status(400).json({ error: { code: "INVALID_OPERATOR_TARGET" } }); return; }
      void action(id).then((result) => res.json(result)).catch((error: unknown) => {
        if (error instanceof OperatorConflict) {
          res.status(409).json({ error: { code: "OPERATOR_ACTION_CONFLICT", reason: error.message } });
        } else next(error);
      });
    });
  }
  return router;
}
