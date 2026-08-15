import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";
import { canonicalHash } from "./canonical.js";
import type { StandardRailConfig } from "./config.js";
import { finalizeReputationOperation } from "./reputationFinalization.js";
import {
  encodeReputationOperation,
  type ReputationOperationIntent,
} from "./reputationOperation.js";
import { refreshReputationPermit, reputationPermitDeadline } from "./reputationOrders.js";
import { hasFinalizedNonceConflict } from "./nonceConflict.js";

interface OperationRow {
  operation_id: string;
  order_id: string;
  kind: "register" | "confirmation" | "refund" | "mirror";
  intent_hash: Buffer;
  canonical_intent: ReputationOperationIntent;
  attempts: number;
}

interface TransactionRow {
  transaction_id: string;
  nonce: string;
  encrypted_raw_transaction: Buffer;
  transaction_hash: Hex;
  state: "prepared" | "broadcast" | "operator_attention";
}

class AmbiguousReputationWrite extends Error {}
class ReputationRpcUnavailable extends Error {}

const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

function encryptRaw(raw: Hex, key: Buffer, operationId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`standard-reputation:${operationId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptRaw(value: Buffer, key: Buffer, operationId: string): Hex {
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(`standard-reputation:${operationId}`, "utf8"));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([
    decipher.update(value.subarray(28)),
    decipher.final(),
  ]).toString("utf8") as Hex;
}

export class StandardReputationWorker {
  private readonly account;
  private readonly client;
  private readonly evidenceClients: Array<ReturnType<typeof createPublicClient>>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private nextKind = 0;

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chain: Chain,
  ) {
    this.account = privateKeyToAccount(config.reputationRelayerPrivateKey);
    this.client = createPublicClient({
      chain,
      transport: fallback(config.evidenceRpcUrls.map((url) =>
        http(url, { retryCount: 0, timeout: 20_000 })), { rank: false }),
    });
    this.evidenceClients = config.evidenceRpcUrls.map((url) => createPublicClient({
      chain,
      transport: http(url, { retryCount: 0, timeout: 20_000 }),
    }));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.schedule(), this.config.recoveryIntervalMs);
    this.timer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

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
      minimumReserveWei: this.config.reputationMinimumReserveWei.toString(),
      reserveReady: balance === null ? null : balance >= this.config.reputationMinimumReserveWei,
      maxFeePerGasWei: this.config.reputationMaxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: this.config.reputationMaxPriorityFeePerGasWei.toString(),
    };
  }

  private schedule(): void {
    if (this.running) return;
    this.running = this.runBatch()
      .catch((error) => logger.error("standard reputation recovery failed", { error }))
      .finally(() => { this.running = null; });
  }

  private async runBatch(): Promise<void> {
    const kinds = ["register", "refund", "confirmation"] as const;
    for (let count = 0; count < 12; count += 1) {
      const kind = kinds[this.nextKind % kinds.length]!;
      this.nextKind += 1;
      const result = await this.pool.query<OperationRow>(
        `SELECT * FROM standard_reputation_operations
          WHERE kind=$1 AND state IN ('pending','broadcast') AND next_attempt_at<=now()
          ORDER BY next_attempt_at,created_at LIMIT 1`,
        [kind],
      );
      const operation = result.rows[0];
      if (!operation) continue;
      try {
        await this.process(operation);
      } catch (error) {
        if (!(error instanceof AmbiguousReputationWrite)) {
          await this.fail(operation, error instanceof ReputationRpcUnavailable
            ? "rpc_finality" : "application_fault");
        }
      }
    }
  }

  private async process(operation: OperationRow): Promise<void> {
    if (operation.kind !== "register") {
      const parent = await this.pool.query<{ state: string }>(
        `SELECT state FROM standard_reputation_operations
          WHERE order_id=$1 AND kind='register'`,
        [operation.order_id],
      );
      const state = parent.rows[0]?.state;
      if (state?.startsWith("aborted") || state === "blocked_parent_aborted") {
        await this.pool.query(
          `UPDATE standard_reputation_operations SET state='blocked_parent_aborted',
             next_attempt_at=NULL,updated_at=now() WHERE operation_id=$1`,
          [operation.operation_id],
        );
        return;
      }
      if (state !== "final") {
        await this.pool.query(
          `UPDATE standard_reputation_operations SET next_attempt_at=now()+interval '5 seconds',
             updated_at=now() WHERE operation_id=$1`,
          [operation.operation_id],
        );
        return;
      }
    }
    const existing = await this.pool.query<TransactionRow>(
      `SELECT * FROM standard_reputation_transactions
        WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention')
        ORDER BY created_at DESC LIMIT 1`,
      [operation.operation_id],
    );
    if (existing.rows[0]) {
      await this.reconcile(operation, existing.rows[0]);
      return;
    }
    await this.prepareAndBroadcast(await this.refreshPermitIfNeeded(operation));
  }

  private async refreshPermitIfNeeded(operation: OperationRow): Promise<OperationRow> {
    const deadline = reputationPermitDeadline(operation.canonical_intent);
    if (deadline === null || deadline > BigInt(Math.floor(Date.now() / 1_000) + 60)) return operation;
    const refreshed = await refreshReputationPermit(operation.canonical_intent, this.config, this.chain.id);
    const refreshedHash = canonicalHash(refreshed);
    const previousHash = `0x${operation.intent_hash.toString("hex")}`;
    const result = await this.pool.query<OperationRow>(
      `UPDATE standard_reputation_operations
          SET canonical_intent=$2,intent_hash=$3,
              intent_predecessors=intent_predecessors||jsonb_build_array(jsonb_build_object(
                'intentHash',$4::text,'validBefore',$5::text,'replacedAt',now())),
              updated_at=now()
        WHERE operation_id=$1 AND intent_hash=$6
          AND state IN ('pending','broadcast')
          AND NOT EXISTS (
            SELECT 1 FROM standard_reputation_transactions
             WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention','final')
          )
      RETURNING *`,
      [operation.operation_id, refreshed, bytes(refreshedHash), previousHash,
        deadline.toString(), operation.intent_hash],
    );
    if (result.rows[0]) return result.rows[0];
    const current = await this.pool.query<OperationRow>(
      "SELECT * FROM standard_reputation_operations WHERE operation_id=$1",
      [operation.operation_id],
    );
    if (!current.rows[0]) throw new Error("REPUTATION_OPERATION_MISSING");
    return current.rows[0];
  }

  private async reconcile(operation: OperationRow, transaction: TransactionRow): Promise<void> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: transaction.transaction_hash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw new ReputationRpcUnavailable();
    }
    if (!receipt) {
      let pending;
      try {
        pending = await this.client.getTransaction({ hash: transaction.transaction_hash });
      } catch (error) {
        if (!(error instanceof TransactionNotFoundError)) throw new ReputationRpcUnavailable();
      }
      if (pending) {
        await this.markBroadcastAndDefer(operation.operation_id, transaction.transaction_id);
        return;
      }
      await this.broadcastPersisted(operation, transaction);
      return;
    }
    const head = await this.client.getBlockNumber();
    if (head < receipt.blockNumber + BigInt(this.config.finalityConfirmations - 1)) {
      await this.defer(operation.operation_id);
      return;
    }
    let canonicalBlock;
    try {
      canonicalBlock = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    } catch {
      throw new ReputationRpcUnavailable();
    }
    if (!canonicalBlock || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      await this.defer(operation.operation_id);
      return;
    }
    if (receipt.status === "success") {
      await finalizeReputationOperation({
        pool: this.pool,
        operation,
        transactionId: transaction.transaction_id,
        easAddress: this.config.easAddress,
        receipt,
      });
      return;
    }
    await this.pool.query(
      "UPDATE standard_reputation_transactions SET state='failed',block_number=$2,final_at=now(),updated_at=now() WHERE transaction_id=$1",
      [transaction.transaction_id, receipt.blockNumber.toString()],
    );
    await this.fail(operation, "contract_rejection");
  }

  private async prepareAndBroadcast(operation: OperationRow): Promise<void> {
    const balance = await this.client.getBalance({ address: this.account.address });
    if (balance < this.config.reputationMinimumReserveWei) {
      await this.fail(operation, "balance_fee");
      return;
    }
    const encoded = encodeReputationOperation(operation.canonical_intent, this.config);
    const client = await this.pool.connect();
    let prepared: TransactionRow | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `reputation-relayer:${this.chain.id}:${this.account.address.toLowerCase()}`,
      ]);
      const current = await client.query<{ state: string }>(
        "SELECT state FROM standard_reputation_operations WHERE operation_id=$1 FOR UPDATE",
        [operation.operation_id],
      );
      if (!current.rows[0] || !["pending", "broadcast"].includes(current.rows[0].state)) {
        await client.query("COMMIT");
        return;
      }
      const raced = await client.query<TransactionRow>(
        `SELECT * FROM standard_reputation_transactions
          WHERE operation_id=$1 AND state IN ('prepared','broadcast','operator_attention')
          ORDER BY created_at DESC LIMIT 1`,
        [operation.operation_id],
      );
      prepared = raced.rows[0] ?? await this.persistPrepared(client, operation, encoded);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (prepared) await this.reconcile(operation, prepared);
  }

  private async persistPrepared(
    client: PoolClient,
    operation: OperationRow,
    encoded: { data: Hex; destination: `0x${string}`; gas: bigint },
  ): Promise<TransactionRow> {
    const chainNonce = await this.client.getTransactionCount({
      address: this.account.address,
      blockTag: "pending",
    });
    const local = await client.query<{ nonce: string }>(
      `SELECT nonce::text FROM standard_reputation_transactions
        WHERE chain_id=$1 AND relayer_address=$2
          AND state IN ('prepared','broadcast','operator_attention') AND nonce >= $3
        ORDER BY nonce`,
      [this.chain.id, this.account.address.toLowerCase(), chainNonce],
    );
    let nonce = chainNonce;
    for (const row of local.rows) {
      const occupied = Number(row.nonce);
      if (!Number.isSafeInteger(occupied)) throw new Error("RELAYER_NONCE_INVALID");
      if (occupied === nonce) nonce += 1;
      else if (occupied > nonce) break;
    }
    const raw = await this.account.signTransaction({
      chainId: this.chain.id,
      to: encoded.destination,
      data: encoded.data,
      value: 0n,
      nonce,
      gas: encoded.gas,
      maxFeePerGas: this.config.reputationMaxFeePerGasWei,
      maxPriorityFeePerGas: this.config.reputationMaxPriorityFeePerGasWei,
      type: "eip1559",
    });
    const hash = keccak256(raw);
    const id = randomUUID();
    const encrypted = encryptRaw(raw, this.config.encryptionKey, operation.operation_id);
    await client.query(
      `INSERT INTO standard_reputation_transactions
        (transaction_id,operation_id,chain_id,relayer_address,nonce,destination,value,
         intent_hash,calldata_hash,encrypted_raw_transaction,transaction_hash,state)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,'prepared')`,
      [id, operation.operation_id, this.chain.id, this.account.address.toLowerCase(), nonce.toString(),
        getAddress(encoded.destination).toLowerCase(), operation.intent_hash,
        bytes(keccak256(encoded.data)), encrypted, hash],
    );
    await client.query(
      "UPDATE standard_reputation_operations SET state='broadcast',updated_at=now() WHERE operation_id=$1",
      [operation.operation_id],
    );
    return {
      transaction_id: id,
      nonce: nonce.toString(),
      encrypted_raw_transaction: encrypted,
      transaction_hash: hash,
      state: "prepared",
    };
  }

  private async broadcastPersisted(operation: OperationRow, transaction: TransactionRow): Promise<void> {
    const raw = decryptRaw(
      transaction.encrypted_raw_transaction,
      this.config.encryptionKey,
      operation.operation_id,
    );
    try {
      const submitted = await this.client.sendRawTransaction({ serializedTransaction: raw });
      if (submitted.toLowerCase() !== transaction.transaction_hash.toLowerCase()) {
        await this.resolveNonceConflict(operation, transaction);
        return;
      }
      try {
        await this.markBroadcastAndDefer(operation.operation_id, transaction.transaction_id);
      } catch {
        throw new AmbiguousReputationWrite("broadcast accepted before journal update");
      }
    } catch (error) {
      if (error instanceof AmbiguousReputationWrite) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/already known|known transaction/i.test(message)) {
        await this.markBroadcastAndDefer(operation.operation_id, transaction.transaction_id);
      } else if (/nonce too low|replacement transaction underpriced/i.test(message)) {
        await this.resolveNonceConflict(operation, transaction);
      } else if (/insufficient funds|intrinsic gas|invalid sender|fee|max fee|base fee/i.test(message)) {
        if (transaction.state === "prepared") {
          await this.fail(operation, "balance_fee", transaction.transaction_id);
        } else {
          await this.fail(operation, "balance_fee");
        }
      } else {
        await this.fail(operation, "rpc_finality");
      }
    }
  }

  private async markBroadcastAndDefer(operationId: string, transactionId: string): Promise<void> {
    await this.pool.query(
      `WITH marked AS (
         UPDATE standard_reputation_transactions SET state='broadcast',updated_at=now()
          WHERE transaction_id=$2 AND state IN ('prepared','broadcast','operator_attention')
       )
       UPDATE standard_reputation_operations
          SET state='broadcast',next_attempt_at=now()+interval '5 seconds',updated_at=now()
        WHERE operation_id=$1 AND state IN ('pending','broadcast')`,
      [operationId, transactionId],
    );
  }

  private async defer(operationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE standard_reputation_operations
          SET next_attempt_at=now()+interval '5 seconds',updated_at=now()
        WHERE operation_id=$1 AND state IN ('pending','broadcast')`,
      [operationId],
    );
  }

  private async resolveNonceConflict(operation: OperationRow, transaction: TransactionRow): Promise<void> {
    const receipts = await Promise.all(this.evidenceClients.map(async (client) => {
      try {
        return await client.getTransactionReceipt({ hash: transaction.transaction_hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw new ReputationRpcUnavailable();
      }
    }));
    const receipt = receipts.find((candidate) => candidate !== null);
    if (receipt) {
      await this.reconcile(operation, transaction);
      return;
    }
    const finalizedNonces = await Promise.all(this.evidenceClients.map((client) =>
      client.getTransactionCount({ address: this.account.address, blockTag: "finalized" })
        .catch(() => { throw new ReputationRpcUnavailable(); })));
    if (hasFinalizedNonceConflict(finalizedNonces.map(BigInt), BigInt(transaction.nonce))) {
      const result = await this.pool.query(
        `WITH marked AS (
           UPDATE standard_reputation_transactions SET state='failed',updated_at=now()
            WHERE transaction_id=$2 AND state IN ('prepared','broadcast','operator_attention')
         )
         UPDATE standard_reputation_operations
            SET state='operator_attention',next_attempt_at=NULL,last_error_class='nonce_conflict',updated_at=now()
          WHERE operation_id=$1 AND state IN ('pending','broadcast','operator_attention')`,
        [operation.operation_id, transaction.transaction_id],
      );
      if (result.rowCount === 1) {
        logger.warn("standard reputation operation requires attention", {
          operationId: operation.operation_id,
          reason: "nonce_conflict",
        });
      }
      return;
    }
    await this.defer(operation.operation_id);
  }

  private async fail(operation: OperationRow, reason: string, transactionId?: string): Promise<void> {
    const attempts = operation.attempts + 1;
    const terminal = attempts >= 5;
    const delay = terminal ? null : this.config.reputationRetryDelaysSeconds[attempts - 1]!;
    if (terminal && transactionId) {
      await this.pool.query(
        `UPDATE standard_reputation_transactions SET state='failed',updated_at=now()
          WHERE transaction_id=$1 AND state='prepared'`,
        [transactionId],
      );
    }
    const result = await this.pool.query(
      `UPDATE standard_reputation_operations SET attempts=$2,last_error_class=$3,
         state=$4,next_attempt_at=CASE WHEN $5::integer IS NULL THEN NULL ELSE now()+($5::text||' seconds')::interval END,
         updated_at=now() WHERE operation_id=$1 AND state IN ('pending','broadcast')`,
      [operation.operation_id, attempts, reason, terminal ? "operator_attention" : "pending", delay],
    );
    if (terminal && result.rowCount === 1) {
      logger.warn("standard reputation operation exhausted automatic retries", {
        operationId: operation.operation_id,
        reason,
        attempts,
      });
    }
  }
}
