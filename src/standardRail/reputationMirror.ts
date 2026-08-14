import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool, } from "../db/pool.js";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";

const abi = parseAbi([
  "function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId,uint64 feedbackIndex)",
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
]);

interface MirrorRow {
  order_id: string;
  desired_revision: string;
  desired_confirmation: "Confirmed" | "NotConfirmed" | null;
  desired_uid: Buffer | null;
  active_feedback_index: string | null;
  active_uid: Buffer | null;
  state: string;
  transaction_count: number;
  attempts: number;
  provider_agent_id: string;
  outcome_id: string;
}
interface TxRow {
  transaction_id: string;
  desired_revision: string;
  operation: "give" | "revoke";
  target_uid: Buffer | null;
  target_confirmation: "Confirmed" | "NotConfirmed" | null;
  nonce: string;
  transaction_hash: Hex;
  encrypted_raw_transaction: Buffer;
  state: "prepared" | "broadcast" | "operator_attention";
}

function crypt(raw: Hex, key: Buffer, orderId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`standard-mirror:${orderId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
function decrypt(value: Buffer, key: Buffer, orderId: string): Hex {
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(`standard-mirror:${orderId}`, "utf8"));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8") as Hex;
}

export class StandardReputationMirror {
  private readonly account;
  private readonly client;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly pool: Pool, private readonly config: StandardRailConfig,
    private readonly chain: Chain) {
    this.account = privateKeyToAccount(config.mirror.privateKey);
    this.client = createPublicClient({ chain, transport: http(config.evidenceRpcUrls[0], {
      retryCount: 0, timeout: 20_000,
    }) });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.config.recoveryIntervalMs);
    this.timer.unref();
    this.schedule();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
  async accountHealth(): Promise<Record<string, unknown>> {
    const [finalizedNonce, pendingNonce, balance] = await Promise.all([
      this.client.getTransactionCount({ address: this.account.address, blockTag: "finalized" })
        .then(String).catch(() => null),
      this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" })
        .then(String).catch(() => null),
      this.client.getBalance({ address: this.account.address }).catch(() => null),
    ]);
    return {
      chainId: this.chain.id,
      address: this.account.address,
      finalizedNonce,
      pendingNonce,
      balanceWei: balance?.toString() ?? null,
      minimumReserveWei: this.config.mirror.minimumReserveWei.toString(),
      reserveReady: balance === null ? null : balance >= this.config.mirror.minimumReserveWei,
      maxFeePerGasWei: this.config.mirror.maxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: this.config.mirror.maxPriorityFeePerGasWei.toString(),
    };
  }
  private schedule(): void {
    if (this.running) return;
    this.running = this.tick().catch((error) => logger.error("reputation mirror recovery failed", { error }))
      .finally(() => { this.running = null; });
  }
  private async tick(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      const result = await this.pool.query<MirrorRow>(
        `SELECT m.*,o.provider_agent_id,o.outcome_id FROM standard_reputation_mirrors m
          JOIN standard_orders o ON o.order_id=m.order_id
         WHERE m.state IN ('pending','broadcast','paused')
           AND (m.next_attempt_at IS NULL OR m.next_attempt_at<=now())
         ORDER BY m.updated_at LIMIT 1`);
      if (!result.rows[0]) return;
      await this.process(result.rows[0]);
    }
  }
  private async process(row: MirrorRow): Promise<void> {
    const existing = await this.pool.query<TxRow>(
      `SELECT * FROM standard_reputation_mirror_transactions
        WHERE order_id=$1 AND state IN ('prepared','broadcast','operator_attention') ORDER BY created_at LIMIT 1`,
      [row.order_id]);
    if (existing.rows[0]) return this.reconcile(row, existing.rows[0]);
    if (row.active_feedback_index !== null &&
      (!row.desired_uid || !row.active_uid || !row.desired_uid.equals(row.active_uid))) {
      return this.prepare(row, "revoke");
    }
    if (row.desired_uid && row.desired_confirmation && !row.active_uid) return this.prepare(row, "give");
    await this.pool.query("UPDATE standard_reputation_mirrors SET state='current',updated_at=now() WHERE order_id=$1",
      [row.order_id]);
  }
  private async prepare(row: MirrorRow, operation: "give" | "revoke"): Promise<void> {
    void operation;
    const balance = await this.client.getBalance({ address: this.account.address });
    if (balance < this.config.mirror.minimumReserveWei) return this.pause(row, "balance_fee", false);
    const db = await this.pool.connect();
    let prepared: TxRow | null = null;
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `mirror:${this.chain.id}:${this.account.address.toLowerCase()}`]);
      const current = await db.query<MirrorRow>(
        `SELECT m.*,o.provider_agent_id,o.outcome_id FROM standard_reputation_mirrors m
          JOIN standard_orders o ON o.order_id=m.order_id
         WHERE m.order_id=$1 FOR UPDATE OF m`,
        [row.order_id],
      );
      const fresh = current.rows[0];
      if (!fresh || !["pending", "paused", "broadcast"].includes(fresh.state)) {
        await db.query("COMMIT");
        return;
      }
      const active = await db.query<TxRow>(
        `SELECT * FROM standard_reputation_mirror_transactions
          WHERE order_id=$1 AND state IN ('prepared','broadcast','operator_attention') ORDER BY created_at LIMIT 1`,
        [fresh.order_id],
      );
      if (active.rows[0]) {
        prepared = active.rows[0];
        await db.query("COMMIT");
        await this.reconcile(fresh, prepared);
        return;
      }
      const effectiveOperation = fresh.active_feedback_index !== null &&
        (!fresh.desired_uid || !fresh.active_uid || !fresh.desired_uid.equals(fresh.active_uid))
        ? "revoke"
        : fresh.desired_uid && fresh.desired_confirmation && !fresh.active_uid
          ? "give"
          : null;
      if (!effectiveOperation) {
        const result = await db.query(
          "UPDATE standard_reputation_mirrors SET state='current',next_attempt_at=NULL,updated_at=now() WHERE order_id=$1",
          [fresh.order_id],
        );
        await db.query("COMMIT");
        if (result.rowCount === 1) {
          logger.warn("reputation mirror requires attention", {
            orderId: fresh.order_id,
            reason: "contract_rejection",
          });
        }
        return;
      }
      if (fresh.transaction_count >= this.config.mirror.maxTransactionsPerOrder) {
        await db.query(
          `UPDATE standard_reputation_mirrors SET state='operator_attention',last_error_class='contract_rejection',
             next_attempt_at=NULL,updated_at=now() WHERE order_id=$1`,
          [fresh.order_id],
        );
        await db.query("COMMIT");
        return;
      }
      const daily = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM standard_reputation_mirror_transactions
          WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      );
      if (Number(daily.rows[0]?.count ?? "0") >= this.config.mirror.maxTransactionsPerUtcDay) {
        await db.query(
          `UPDATE standard_reputation_mirrors SET state='paused',last_error_class='contract_rejection',
             next_attempt_at=(date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC',
             updated_at=now() WHERE order_id=$1`,
          [fresh.order_id],
        );
        await db.query("COMMIT");
        return;
      }
      const uid = fresh.desired_uid ? `0x${fresh.desired_uid.toString("hex")}` as Hex : null;
      const data = effectiveOperation === "revoke"
        ? encodeFunctionData({ abi, functionName: "revokeFeedback",
            args: [BigInt(fresh.provider_agent_id), BigInt(fresh.active_feedback_index!)] })
        : encodeFunctionData({ abi, functionName: "giveFeedback", args: [BigInt(fresh.provider_agent_id),
            fresh.desired_confirmation === "Confirmed" ? 100n : 0n, 0, "daski", fresh.outcome_id, "",
            `${this.chain.id === 8453 ? "https://base.easscan.org" : "https://base-sepolia.easscan.org"}/attestation/view/${uid}`,
            uid!] });
      const chainNonce = await this.client.getTransactionCount({ address: this.account.address, blockTag: "pending" });
      const local = await db.query<{ nonce: string | null }>(
        "SELECT (max(nonce)+1)::text AS nonce FROM standard_reputation_mirror_transactions WHERE chain_id=$1",
        [this.chain.id]);
      const localNonce = local.rows[0]?.nonce === null ? BigInt(chainNonce) : BigInt(local.rows[0]!.nonce!);
      const nonceValue = BigInt(chainNonce) > localNonce ? BigInt(chainNonce) : localNonce;
      if (nonceValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MIRROR_NONCE_INVALID");
      const nonce = Number(nonceValue);
      const raw = await this.account.signTransaction({ chainId: this.chain.id,
        to: this.config.mirror.registry, data, nonce, value: 0n,
        gas: effectiveOperation === "give" ? this.config.mirror.giveGasLimit : this.config.mirror.revokeGasLimit,
        maxFeePerGas: this.config.mirror.maxFeePerGasWei,
        maxPriorityFeePerGas: this.config.mirror.maxPriorityFeePerGasWei, type: "eip1559" });
      const hash = keccak256(raw);
      const transactionId = randomUUID();
      const encrypted = crypt(raw, this.config.encryptionKey, fresh.order_id);
      await db.query(
        `INSERT INTO standard_reputation_mirror_transactions
          (transaction_id,order_id,desired_revision,operation,target_uid,target_confirmation,chain_id,nonce,
           transaction_hash,encrypted_raw_transaction,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared')`,
        [transactionId, fresh.order_id, fresh.desired_revision, effectiveOperation,
          effectiveOperation === "give" ? fresh.desired_uid : null,
          effectiveOperation === "give" ? fresh.desired_confirmation : null,
          this.chain.id, nonce.toString(), hash, encrypted]);
      await db.query("UPDATE standard_reputation_mirrors SET state='broadcast',transaction_count=transaction_count+1,updated_at=now() WHERE order_id=$1",
        [fresh.order_id]);
      await db.query("COMMIT");
      prepared = { transaction_id: transactionId, desired_revision: fresh.desired_revision,
        operation: effectiveOperation, target_uid: effectiveOperation === "give" ? fresh.desired_uid : null,
        target_confirmation: effectiveOperation === "give" ? fresh.desired_confirmation : null,
        nonce: nonce.toString(), transaction_hash: hash, encrypted_raw_transaction: encrypted, state: "prepared" };
      await this.broadcastPrepared(fresh, prepared);
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { db.release(); }
  }
  private async reconcile(row: MirrorRow, tx: TxRow): Promise<void> {
    const receipt = await this.client.getTransactionReceipt({ hash: tx.transaction_hash }).catch(() => null);
    if (!receipt) {
      const pending = await this.client.getTransaction({ hash: tx.transaction_hash }).catch(() => null);
      if (pending) {
        await this.markBroadcastAndDefer(row.order_id, tx.transaction_id);
        return;
      }
      if (tx.state === "prepared") await this.broadcastPrepared(row, tx);
      else await this.defer(row.order_id);
      return;
    }
    const head = await this.client.getBlockNumber();
    if (head < receipt.blockNumber + BigInt(this.config.finalityConfirmations - 1)) {
      await this.defer(row.order_id);
      return;
    }
    const canonicalBlock = await this.client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
    if (!canonicalBlock || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      await this.defer(row.order_id);
      return;
    }
    if (receipt.status !== "success") {
      await this.pool.query("UPDATE standard_reputation_mirror_transactions SET state='failed',block_number=$2,updated_at=now() WHERE transaction_id=$1",
        [tx.transaction_id, receipt.blockNumber.toString()]);
      return this.retry(row, "contract_rejection");
    }
    try {
      await this.finish(row, tx, receipt);
    } catch {
      await this.pool.query(
        `WITH marked AS (
           UPDATE standard_reputation_mirror_transactions SET state='operator_attention',block_number=$2,
             updated_at=now() WHERE transaction_id=$1
         )
           UPDATE standard_reputation_mirrors SET state='operator_attention',last_error_class='application_fault',
           next_attempt_at=NULL,updated_at=now() WHERE order_id=$3`,
        [tx.transaction_id, receipt.blockNumber.toString(), row.order_id],
      );
      logger.warn("reputation mirror requires attention", {
        orderId: row.order_id,
        reason: "application_fault",
      });
    }
  }
  private async finish(row: MirrorRow, tx: TxRow, receipt: TransactionReceipt): Promise<void> {
    let feedbackIndex: bigint | null = null;
    if (tx.operation === "give") {
      const logs = parseEventLogs({ abi, logs: receipt.logs, strict: false });
      const event = logs.find((item) => item.eventName === "NewFeedback");
      if (!event || !("feedbackIndex" in event.args)) throw new Error("MIRROR_FEEDBACK_INDEX_MISSING");
      const uid = tx.target_uid ? `0x${tx.target_uid.toString("hex")}`.toLowerCase() : null;
      if (!uid || !event.args.clientAddress || !event.args.feedbackHash ||
        event.args.agentId !== BigInt(row.provider_agent_id) ||
        event.args.clientAddress.toLowerCase() !== this.account.address.toLowerCase() ||
        event.args.feedbackHash.toLowerCase() !== uid ||
        event.args.value !== (tx.target_confirmation === "Confirmed" ? 100n : 0n) ||
        event.args.valueDecimals !== 0 || event.args.tag1 !== "daski" || event.args.tag2 !== row.outcome_id) {
        throw new Error("MIRROR_FEEDBACK_EVENT_MISMATCH");
      }
      feedbackIndex = event.args.feedbackIndex as bigint;
    }
    await this.pool.query(
      `WITH done AS (UPDATE standard_reputation_mirror_transactions SET state='final',block_number=$2,
         updated_at=now() WHERE transaction_id=$1)
       UPDATE standard_reputation_mirrors SET active_feedback_index=$3,
         active_uid=CASE WHEN $4='give' THEN $5 ELSE NULL END,
         state=CASE WHEN desired_revision=$6::bigint
           THEN CASE WHEN $4='give' OR desired_uid IS NULL THEN 'current' ELSE 'pending' END
           ELSE 'pending' END,
         attempts=0,next_attempt_at=CASE WHEN desired_revision=$6::bigint
           AND ($4='give' OR desired_uid IS NULL) THEN NULL ELSE now() END,
         updated_at=now() WHERE order_id=$7`,
      [tx.transaction_id, receipt.blockNumber.toString(), feedbackIndex?.toString() ?? null,
        tx.operation, tx.target_uid, tx.desired_revision, row.order_id]);
  }
  private async retry(row: MirrorRow, reason: string): Promise<void> {
    const attempts = row.attempts + 1;
    const terminal = attempts >= 5;
    const delay = terminal ? null : this.config.reputationRetryDelaysSeconds[attempts - 1]!;
    const result = await this.pool.query(`UPDATE standard_reputation_mirrors SET attempts=$2,last_error_class=$3,
      state=$4,next_attempt_at=CASE WHEN $5::integer IS NULL THEN NULL ELSE now()+($5||' seconds')::interval END,
      updated_at=now() WHERE order_id=$1`, [row.order_id, attempts, reason,
      terminal ? "operator_attention" : "pending", delay]);
    if (terminal && result.rowCount === 1) {
      logger.warn("reputation mirror exhausted automatic retries", {
        orderId: row.order_id,
        reason,
        attempts,
      });
    }
  }

  private async broadcastPrepared(row: MirrorRow, tx: TxRow): Promise<void> {
    const raw = decrypt(tx.encrypted_raw_transaction, this.config.encryptionKey, row.order_id);
    try {
      const submitted = await this.client.sendRawTransaction({ serializedTransaction: raw });
      if (submitted.toLowerCase() !== tx.transaction_hash.toLowerCase()) {
        await this.resolveNonceConflict(row, tx);
        return;
      }
      await this.markBroadcastAndDefer(row.order_id, tx.transaction_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already known|known transaction/i.test(message)) {
        await this.markBroadcastAndDefer(row.order_id, tx.transaction_id);
      } else if (/nonce too low|replacement transaction underpriced/i.test(message)) {
        await this.resolveNonceConflict(row, tx);
      } else if (/insufficient funds|intrinsic gas|invalid sender|fee|max fee|base fee/i.test(message)) {
        await this.retry(row, "balance_fee");
        if (row.attempts + 1 >= 5) {
          await this.pool.query(
            "UPDATE standard_reputation_mirror_transactions SET state='failed',updated_at=now() WHERE transaction_id=$1 AND state='prepared'",
            [tx.transaction_id],
          );
        }
      } else {
        await this.defer(row.order_id);
      }
    }
  }

  private async markBroadcastAndDefer(orderId: string, transactionId: string): Promise<void> {
    await this.pool.query(
      `WITH marked AS (
         UPDATE standard_reputation_mirror_transactions SET state='broadcast',updated_at=now()
          WHERE transaction_id=$2 AND state IN ('prepared','broadcast','operator_attention')
       )
       UPDATE standard_reputation_mirrors SET state='broadcast',next_attempt_at=now()+interval '5 seconds',
         updated_at=now() WHERE order_id=$1 AND state IN ('pending','broadcast','paused')`,
      [orderId, transactionId],
    );
  }

  private async defer(orderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE standard_reputation_mirrors SET next_attempt_at=now()+interval '5 seconds',updated_at=now()
        WHERE order_id=$1 AND state IN ('pending','broadcast','paused')`,
      [orderId],
    );
  }

  private async resolveNonceConflict(row: MirrorRow, tx: TxRow): Promise<void> {
    const finalizedNonce = await this.client.getTransactionCount({
      address: this.account.address,
      blockTag: "finalized",
    }).catch(() => null);
    if (finalizedNonce !== null && BigInt(finalizedNonce) > BigInt(tx.nonce)) {
      const result = await this.pool.query(
        `WITH marked AS (
           UPDATE standard_reputation_mirror_transactions SET state='failed',updated_at=now()
            WHERE transaction_id=$2 AND state IN ('prepared','broadcast')
         )
         UPDATE standard_reputation_mirrors SET state='operator_attention',last_error_class='nonce_conflict',
           next_attempt_at=NULL,updated_at=now() WHERE order_id=$1`,
        [row.order_id, tx.transaction_id],
      );
      if (result.rowCount === 1) {
        logger.warn("reputation mirror requires attention", {
          orderId: row.order_id,
          reason: "nonce_conflict",
        });
      }
      return;
    }
    const result = await this.pool.query(
      `UPDATE standard_reputation_mirrors SET state='operator_attention',last_error_class='nonce_conflict',
         next_attempt_at=NULL,updated_at=now() WHERE order_id=$1`,
      [row.order_id],
    );
    if (result.rowCount === 1) {
      logger.warn("reputation mirror requires attention", {
        orderId: row.order_id,
        reason: "nonce_conflict",
      });
    }
  }
  private async pause(row: MirrorRow, reason: string, terminal: boolean, nextDay = false): Promise<void> {
    await this.pool.query(`UPDATE standard_reputation_mirrors SET state=$2,last_error_class=$3,
      next_attempt_at=CASE WHEN $4 THEN date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day'
        ELSE now()+interval '5 minutes' END,updated_at=now() WHERE order_id=$1`,
    [row.order_id, terminal ? "operator_attention" : "paused", reason, nextDay]);
  }
}
