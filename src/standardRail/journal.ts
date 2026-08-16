import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import type { EvidenceResult } from "./evidence.js";
import { canonicalHash } from "./canonical.js";
import type { SignedEnvelope, StandardRailDispatchV1 } from "./types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export class StandardRailJournal {
  constructor(private readonly pool: Pool) {}

  async markVerifyInvoked(orderId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE standard_settlement_attempts SET verify_invoked_at=COALESCE(verify_invoked_at,now())
       WHERE order_id=$1`,
      [orderId],
    );
    if (result.rowCount !== 1) throw new Error("VERIFY_ATTEMPT_MISSING");
  }

  async recordVerify(orderId: string, responseHash: Hex, valid: boolean): Promise<void> {
    const result = await this.pool.query(
      `UPDATE standard_settlement_attempts
          SET verify_response_hash=COALESCE(verify_response_hash,$2),
              terminal_kind=CASE WHEN $3 THEN terminal_kind ELSE 'verify_rejected' END
        WHERE order_id=$1 AND (verify_response_hash IS NULL OR verify_response_hash=$2)`,
      [orderId, bytes(responseHash), valid],
    );
    if (result.rowCount !== 1) throw new Error("VERIFY_RESPONSE_EQUIVOCATION");
  }

  async verifyRecord(orderId: string): Promise<{ valid: boolean } | null> {
    const result = await this.pool.query<{ verify_response_hash: Buffer | null; terminal_kind: string | null }>(
      `SELECT verify_response_hash,terminal_kind FROM standard_settlement_attempts WHERE order_id=$1`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row?.verify_response_hash) return null;
    return { valid: row.terminal_kind !== "verify_rejected" };
  }

  async markSettleInvoked(orderId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE standard_settlement_attempts SET settle_invoked_at=now()
       WHERE order_id=$1 AND settle_invoked_at IS NULL`,
      [orderId],
    );
    if (result.rowCount === 1) return true;
    const existing = await this.pool.query(
      "SELECT 1 FROM standard_settlement_attempts WHERE order_id=$1 AND settle_invoked_at IS NOT NULL",
      [orderId],
    );
    if (existing.rowCount !== 1) throw new Error("SETTLE_ATTEMPT_MISSING");
    return false;
  }

  async recordSettlement(
    orderId: string,
    responseHash: Hex,
    transactionHash: Hex,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE standard_settlement_attempts
          SET settle_response_hash=COALESCE(settle_response_hash,$2),
              settlement_tx_hash=COALESCE(settlement_tx_hash,$3),terminal_kind='confirmed'
        WHERE order_id=$1
          AND (settle_response_hash IS NULL OR settle_response_hash=$2)
          AND (settlement_tx_hash IS NULL OR settlement_tx_hash=$3)`,
      [orderId, bytes(responseHash), transactionHash],
    );
    if (result.rowCount !== 1) throw new Error("SETTLEMENT_RESPONSE_EQUIVOCATION");
  }

  async recordEvidence(
    orderId: string,
    kind: "deposit" | "release",
    result: EvidenceResult,
    chainId: number,
  ): Promise<void> {
    const inserted = await this.pool.query(
      `INSERT INTO standard_chain_evidence (
        evidence_hash,order_id,evidence_kind,chain_id,block_number,block_hash,
        transaction_hash,transaction_index,log_index,source_fingerprints,canonical_evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (evidence_hash) DO UPDATE
         SET evidence_hash=EXCLUDED.evidence_hash
       WHERE standard_chain_evidence.order_id=EXCLUDED.order_id
         AND standard_chain_evidence.evidence_kind=EXCLUDED.evidence_kind
       RETURNING evidence_hash`,
      [
        bytes(result.evidenceHash), orderId, kind, chainId,
        result.blockNumber.toString(), result.blockHash, result.transactionHash,
        result.transactionIndex, result.logIndex,
        JSON.stringify(result.sources), result.canonicalEvidence,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error("CHAIN_EVIDENCE_REPLAYED_ACROSS_ORDERS");
  }

  async loadEvidence(orderId: string, kind: "deposit" | "release"): Promise<EvidenceResult> {
    const result = await this.pool.query<{
      transaction_hash: Hex;
      block_number: string;
      block_hash: Hex;
      transaction_index: number;
      log_index: number;
      evidence_hash: Buffer;
      canonical_evidence: Record<string, unknown>;
      source_fingerprints: string[];
    }>(
      `SELECT transaction_hash,block_number::text,block_hash,transaction_index,log_index,
              evidence_hash,canonical_evidence,source_fingerprints
         FROM standard_chain_evidence WHERE order_id=$1 AND evidence_kind=$2
         ORDER BY observed_at DESC LIMIT 1`,
      [orderId, kind],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Missing ${kind} evidence for recovery`);
    return {
      transactionHash: row.transaction_hash,
      blockNumber: BigInt(row.block_number),
      blockHash: row.block_hash,
      transactionIndex: row.transaction_index,
      logIndex: row.log_index,
      evidenceHash: `0x${row.evidence_hash.toString("hex")}`,
      canonicalEvidence: row.canonical_evidence,
      sources: row.source_fingerprints,
    };
  }

  async settlementResponseHash(orderId: string): Promise<Hex> {
    const result = await this.pool.query<{ settle_response_hash: Buffer | null }>(
      "SELECT settle_response_hash FROM standard_settlement_attempts WHERE order_id=$1",
      [orderId],
    );
    const hash = result.rows[0]?.settle_response_hash;
    return hash ? `0x${hash.toString("hex")}` : canonicalHash({ orderId, recovered: true });
  }

  async settlementRecord(orderId: string): Promise<{
    responseHash: Hex;
    transactionHash: Hex;
  } | null> {
    const result = await this.pool.query<{
      settle_response_hash: Buffer | null;
      settlement_tx_hash: Hex | null;
    }>(
      `SELECT settle_response_hash,settlement_tx_hash FROM standard_settlement_attempts
       WHERE order_id=$1`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row?.settle_response_hash || !row.settlement_tx_hash) return null;
    return {
      responseHash: `0x${row.settle_response_hash.toString("hex")}`,
      transactionHash: row.settlement_tx_hash,
    };
  }

  async claimDispatch(args: {
    orderId: string;
    nonce: Hex;
    dispatchHash: Hex;
    requestHash: Hex;
    dispatch: SignedEnvelope<StandardRailDispatchV1>;
    request: unknown;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO standard_dispatch_claims
        (order_id,dispatch_nonce,dispatch_hash,request_hash,canonical_dispatch,canonical_request,
         invocation_state,invoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,'invoked',now())
       ON CONFLICT (order_id) DO NOTHING`,
      [args.orderId, bytes(args.nonce), bytes(args.dispatchHash), bytes(args.requestHash), args.dispatch, args.request],
    );
    return result.rowCount === 1;
  }

  async dispatchClaim(orderId: string): Promise<{
    dispatch: SignedEnvelope<StandardRailDispatchV1>;
    request: unknown;
  } | null> {
    const result = await this.pool.query<{
      canonical_dispatch: SignedEnvelope<StandardRailDispatchV1>;
      canonical_request: unknown;
    }>(
      "SELECT canonical_dispatch,canonical_request FROM standard_dispatch_claims WHERE order_id=$1",
      [orderId],
    );
    return result.rows[0]
      ? { dispatch: result.rows[0].canonical_dispatch, request: result.rows[0].canonical_request }
      : null;
  }

  async resolveDispatch(orderId: string, taskId: string, responseHash: Hex): Promise<void> {
    await this.pool.query(
      `UPDATE standard_dispatch_claims
          SET invocation_state='accepted',provider_task_id=$2,response_hash=$3,resolved_at=now()
        WHERE order_id=$1 AND invocation_state='invoked'`,
      [orderId, taskId, bytes(responseHash)],
    );
  }

  async dispatchResolvedAt(orderId: string): Promise<Date | null> {
    const result = await this.pool.query<{ resolved_at: Date | null }>(
      "SELECT resolved_at FROM standard_dispatch_claims WHERE order_id=$1",
      [orderId],
    );
    return result.rows[0]?.resolved_at ?? null;
  }

  async consumeActionNonce(args: {
    payer: Hex;
    nonce: Hex;
    orderId: string;
    action: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `INSERT INTO standard_action_nonces (payer,nonce,order_id,action)
       VALUES ($1,$2,$3,$4) ON CONFLICT (payer,nonce) DO NOTHING`,
      [args.payer, bytes(args.nonce), args.orderId, args.action],
    );
    if (result.rowCount !== 1) throw new Error("ACTION_AUTHORIZATION_REPLAYED");
  }

  async issueActionChallenge(args: {
    orderId: string | null;
    action: string;
    requestHash: Hex;
    absoluteResourceUri: string;
    nonce: Hex;
    issuedAt: number;
    validBefore: number;
    clientKeyHash: Buffer;
    outstandingPerClient: number;
    outstandingGlobal: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "standard:wallet-challenge-cap",
      ]);
      const outstanding = await client.query<{ client_count: string; global_count: string }>(
        `SELECT count(*) FILTER (WHERE client_key_hash=$1)::text AS client_count,
                count(*)::text AS global_count
           FROM (
             SELECT client_key_hash FROM standard_wallet_action_challenges
              WHERE consumed_at IS NULL AND valid_before>now()
             UNION ALL
             SELECT client_key_hash FROM standard_action_challenges
              WHERE consumed_at IS NULL AND valid_before>now()
           ) active`,
        [args.clientKeyHash],
      );
      if (
        Number(outstanding.rows[0]?.client_count ?? "0") >= args.outstandingPerClient ||
        Number(outstanding.rows[0]?.global_count ?? "0") >= args.outstandingGlobal
      ) throw new Error("ACTION_CHALLENGE_CAPACITY_EXCEEDED");
      await client.query(
        `INSERT INTO standard_action_challenges
          (nonce,client_key_hash,order_id,action,canonical_request_hash,absolute_resource_uri,
           issued_at,valid_before)
         VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),to_timestamp($8))`,
        [
          bytes(args.nonce), args.clientKeyHash, args.orderId, args.action, bytes(args.requestHash),
          args.absoluteResourceUri, args.issuedAt, args.validBefore,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async cleanupExpiredActionAuthorizations(): Promise<void> {
    await this.pool.query(
      `DELETE FROM standard_action_challenges
        WHERE valid_before < now() - interval '5 minutes'
           OR consumed_at < now() - interval '5 minutes'`,
    );
    await this.pool.query(
      `DELETE FROM standard_action_nonces
        WHERE consumed_at < now() - interval '10 minutes'`,
    );
  }

  async consumeActionChallenge(args: {
    orderId: string;
    action: string;
    requestHash: Hex;
    absoluteResourceUri: string;
    nonce: Hex;
    issuedAt: number;
    validBefore: number;
    payerRate?: { scope: string; maximum: number };
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(
        `UPDATE standard_action_challenges SET consumed_at=now()
          WHERE nonce=$1 AND order_id=$2 AND action=$3 AND canonical_request_hash=$4
            AND absolute_resource_uri=$5 AND issued_at=to_timestamp($6)
            AND valid_before=to_timestamp($7) AND valid_before>now() AND consumed_at IS NULL`,
        [
          bytes(args.nonce), args.orderId, args.action, bytes(args.requestHash),
          args.absoluteResourceUri, args.issuedAt, args.validBefore,
        ],
      );
      if (consumed.rowCount !== 1) throw new Error("ACTION_CHALLENGE_INVALID_OR_REPLAYED");
      await client.query(
        `INSERT INTO standard_action_nonces(payer,nonce,order_id,action)
         SELECT payer,$2,order_id,$3 FROM standard_orders WHERE order_id=$1`,
        [args.orderId, bytes(args.nonce), args.action],
      );
      if (args.payerRate) {
        const payer = await client.query<{ payer: string }>(
          "SELECT lower(payer) AS payer FROM standard_orders WHERE order_id=$1",
          [args.orderId],
        );
        const wallet = payer.rows[0]?.payer;
        if (!wallet) throw new Error("ACTION_CHALLENGE_INVALID_OR_REPLAYED");
        const bucket = canonicalHash({ scope: args.payerRate.scope, payer: wallet });
        const rate = await client.query<{ request_count: number }>(
          `INSERT INTO rate_limit_buckets(bucket_key,window_started_at,request_count)
           VALUES ($1,now(),1) ON CONFLICT (bucket_key) DO UPDATE SET
             window_started_at=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
               THEN now() ELSE rate_limit_buckets.window_started_at END,
             request_count=CASE WHEN rate_limit_buckets.window_started_at<=now()-interval '1 minute'
               THEN 1 ELSE rate_limit_buckets.request_count+1 END RETURNING request_count`,
          [`standard-order:${bucket}`],
        );
        if ((rate.rows[0]?.request_count ?? args.payerRate.maximum + 1) > args.payerRate.maximum) {
          throw new Error("ACTION_CHALLENGE_INVALID_OR_REPLAYED");
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

}
