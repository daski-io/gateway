import type { Pool } from "../db/pool.js";
import type { Hex } from "../types.js";
import type { EvidenceResult } from "./evidence.js";
import { canonicalHash } from "./canonical.js";
import type { SignedEnvelope, StandardRailDispatchV1 } from "./types.js";

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

export class StandardRailJournal {
  constructor(private readonly pool: Pool) {}

  async withRefundExecutionWalletLock<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", ["standard:refund-execution-wallet"]);
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        "standard:refund-execution-wallet",
      ]).catch(() => undefined);
      client.release();
    }
  }

  async assertRefundExecutionNonceAvailable(orderId: string): Promise<void> {
    const result = await this.pool.query<{ order_id: string }>(
      `SELECT order_id FROM standard_refund_attempts
        WHERE leg='gross' AND order_id<>$1 AND raw_transaction IS NOT NULL
          AND state<>'refunded'
        ORDER BY invoked_at LIMIT 1`,
      [orderId],
    );
    if (result.rows[0]) throw new Error("DASKI_REFUND_WALLET_HAS_UNRESOLVED_NONCE");
  }

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
    kind: "deposit" | "release" | "refund",
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
        result.transactionIndex, result.logIndex, result.sources, result.canonicalEvidence,
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

  async reserveExposure(args: {
    orderId: string;
    providerReservationId: Hex;
    daskiReservationId: Hex;
    token: Hex;
    payer: Hex;
    grossAmount: string;
    providerAmount: string;
    daskiAmount: string;
    executionReserveAvailable: string;
    maximumReservedAmount: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["standard:refund-execution-reserve"]);
      const existing = await client.query<{
        provider_reservation_id: Buffer; daski_reservation_id: Buffer;
        token: string; payer: string; gross_amount: string; provider_reserved: string;
        daski_reserved: string; state: string;
      }>(
        `SELECT provider_reservation_id,daski_reservation_id,token,payer,gross_amount::text,
                provider_reserved::text,daski_reserved::text,state
           FROM standard_refund_exposure WHERE order_id=$1 FOR UPDATE`,
        [args.orderId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.token.toLowerCase() !== args.token.toLowerCase() ||
          `0x${row.provider_reservation_id.toString("hex")}` !== args.providerReservationId ||
          `0x${row.daski_reservation_id.toString("hex")}` !== args.daskiReservationId ||
          row.payer.toLowerCase() !== args.payer.toLowerCase() ||
          row.gross_amount !== args.grossAmount || row.provider_reserved !== args.providerAmount ||
          row.daski_reserved !== args.daskiAmount || row.state !== "reserved"
        ) throw new Error("REFUND_EXECUTION_RESERVE_REPLAY_MISMATCH");
        await client.query("COMMIT");
        return;
      }
      const total = await client.query<{ amount: string }>(
        `SELECT COALESCE(SUM(gross_amount),0)::text AS amount
           FROM standard_refund_exposure WHERE state IN ('reserved','refund_due','invoked','ambiguous')`,
      );
      if (
        BigInt(total.rows[0]!.amount) + BigInt(args.grossAmount) >
        BigInt(args.executionReserveAvailable) ||
        BigInt(total.rows[0]!.amount) + BigInt(args.grossAmount) >
        BigInt(args.maximumReservedAmount)
      ) {
        throw new Error("REFUND_EXECUTION_RESERVE_INSUFFICIENT");
      }
      await client.query(
        `INSERT INTO standard_refund_exposure
          (order_id,provider_reservation_id,daski_reservation_id,token,payer,gross_amount,
           provider_reserved,daski_reserved,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`,
        [
          args.orderId, bytes(args.providerReservationId), bytes(args.daskiReservationId),
          args.token, args.payer, args.grossAmount, args.providerAmount, args.daskiAmount,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refundExposure(orderId: string): Promise<{
    providerReservationId: Hex;
    daskiReservationId: Hex;
    providerAmount: string;
    daskiAmount: string;
    grossAmount: string;
  }> {
    const result = await this.pool.query<{
      provider_reservation_id: Buffer;
      daski_reservation_id: Buffer;
      provider_reserved: string;
      daski_reserved: string;
      gross_amount: string;
    }>(
      `SELECT provider_reservation_id,daski_reservation_id,provider_reserved::text,
              daski_reserved::text,gross_amount::text
         FROM standard_refund_exposure WHERE order_id=$1`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Refund obligation lacks reserved exposure");
    return {
      providerReservationId: `0x${row.provider_reservation_id.toString("hex")}`,
      daskiReservationId: `0x${row.daski_reservation_id.toString("hex")}`,
      providerAmount: row.provider_reserved,
      daskiAmount: row.daski_reserved,
      grossAmount: row.gross_amount,
    };
  }

  async hasRefundExposure(orderId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM standard_refund_exposure WHERE order_id=$1",
      [orderId],
    );
    return result.rowCount === 1;
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
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO standard_action_challenges
        (nonce,order_id,action,canonical_request_hash,absolute_resource_uri,issued_at,valid_before)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7))`,
      [
        bytes(args.nonce), args.orderId, args.action, bytes(args.requestHash),
        args.absoluteResourceUri, args.issuedAt, args.validBefore,
      ],
    );
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRefundLeg(args: {
    orderId: string;
    leg: "gross";
    intentHash: Hex;
    intent: unknown;
  }): Promise<{
    intentHash: Hex;
    intent: unknown;
    rawTransaction: Hex | null;
    transactionHash: Hex | null;
    state: string;
  }> {
    const result = await this.pool.query(
      `INSERT INTO standard_refund_attempts
        (order_id,leg,attempt_sequence,intent_hash,canonical_intent,state,invoked_at)
       VALUES ($1,$2,1,$3,$4,'invoked',now()) ON CONFLICT (order_id,leg,attempt_sequence) DO NOTHING
       RETURNING intent_hash,canonical_intent,raw_transaction,
                 COALESCE(transaction_hash,expected_transaction_hash) AS transaction_hash,state`,
      [args.orderId, args.leg, bytes(args.intentHash), args.intent],
    );
    const row = result.rows[0] ?? (await this.pool.query(
      `SELECT intent_hash,canonical_intent,raw_transaction,
              COALESCE(transaction_hash,expected_transaction_hash) AS transaction_hash,state
         FROM standard_refund_attempts WHERE order_id=$1 AND leg=$2 AND attempt_sequence=1`,
      [args.orderId, args.leg],
    )).rows[0];
    if (!row || `0x${row.intent_hash.toString("hex")}` !== args.intentHash ||
      canonicalHash(row.canonical_intent) !== canonicalHash(args.intent)) {
      throw new Error("REFUND_LEG_CHANGED");
    }
    return {
      intentHash: args.intentHash,
      intent: row.canonical_intent,
      rawTransaction: row.raw_transaction,
      transactionHash: row.transaction_hash,
      state: row.state,
    };
  }

  async refundLeg(orderId: string, leg: "gross"): Promise<{
    intentHash: Hex;
    intent: unknown;
    rawTransaction: Hex | null;
    transactionHash: Hex | null;
    state: string;
  } | null> {
    const result = await this.pool.query(
      `SELECT intent_hash,canonical_intent,raw_transaction,
              COALESCE(transaction_hash,expected_transaction_hash) AS transaction_hash,state
         FROM standard_refund_attempts WHERE order_id=$1 AND leg=$2 AND attempt_sequence=1`,
      [orderId, leg],
    );
    const row = result.rows[0];
    return row ? {
      intentHash: `0x${row.intent_hash.toString("hex")}`,
      intent: row.canonical_intent,
      rawTransaction: row.raw_transaction,
      transactionHash: row.transaction_hash,
      state: row.state,
    } : null;
  }

  async recordRefundPrepared(
    orderId: string,
    leg: "gross",
    rawTransaction: Hex,
    transactionHash: Hex,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE standard_refund_attempts
          SET raw_transaction=$3,expected_transaction_hash=$4
        WHERE order_id=$1 AND leg=$2 AND attempt_sequence=1
          AND (raw_transaction IS NULL OR (raw_transaction=$3 AND expected_transaction_hash=$4))`,
      [orderId, leg, rawTransaction, transactionHash],
    );
    if (result.rowCount !== 1) throw new Error("REFUND_TRANSACTION_CHANGED");
  }

  async recordRefundBroadcast(
    orderId: string,
    leg: "gross",
    transactionHash: Hex,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE standard_refund_attempts SET transaction_hash=$3,state='broadcast'
       WHERE order_id=$1 AND leg=$2 AND attempt_sequence=1 AND state IN ('invoked','ambiguous','broadcast')`,
      [orderId, leg, transactionHash],
    );
  }

  async resolveRefundLeg(orderId: string, leg: "gross", state: "refunded" | "ambiguous"): Promise<void> {
    await this.pool.query(
      `UPDATE standard_refund_attempts SET state=$3,resolved_at=now()
       WHERE order_id=$1 AND leg=$2 AND attempt_sequence=1`,
      [orderId, leg, state],
    );
  }

  async closeExposure(orderId: string, state: "refunded" | "released" | "legal_hold"): Promise<void> {
    await this.pool.query(
      `UPDATE standard_refund_exposure SET state=$2,
         released_at=CASE WHEN $2 IN ('refunded','released') THEN now() ELSE released_at END
       WHERE order_id=$1`,
      [orderId, state],
    );
  }
}
