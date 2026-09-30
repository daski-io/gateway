import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  createPublicClient,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  parseAbi,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Chain,
  type Hex,
  type TransactionReceipt,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PoolClient } from "pg";
import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";
import { canonicalHash } from "./canonical.js";
import {
  type FacilitatorNonceLock,
  PostgresFacilitatorNonceLock,
} from "./facilitatorNonceLock.js";
import type { StandardRailConfig } from "./config.js";
import { withRpcFailover } from "../rpc/failover.js";
import { finalizeReputationOperation, reviewReceiptUid, type ReviewAttestationEvidence } from "./reputationFinalization.js";
import {
  encodeReputationOperation,
  type ReputationOperationIntent,
} from "./reputationOperation.js";
import { refreshReputationPermit, reputationPermitDeadline } from "./reputationOrders.js";
import { EasIncompatible, observeEasProfile, signedDeadlineExpired } from "./easProfiles.js";
import { hasFinalizedNonceConflict } from "./nonceConflict.js";

/** Writes the order's confirmation state through the finalized-read rule. */
export interface ConfirmationStateReconciler {
  reconcile(order: { orderId: string; orderKey: Hex }): Promise<{ final: { blockNumber: string }; changed: boolean }>;
}

interface OperationRow {
  operation_id: string;
  order_id: string;
  kind: "register" | "confirmation" | "confirmation-v2";
  review_relay_until?: Date | null;
  intent_hash: Buffer;
  canonical_intent: ReputationOperationIntent;
  attempts: number;
  state: string;
  last_error_class?: string | null;
}

interface TransactionRow {
  transaction_id: string;
  nonce: string;
  encrypted_raw_transaction: Buffer;
  transaction_hash: Hex;
  state: "prepared" | "broadcast" | "operator_attention" | "failed" | "final";
  updated_at: Date;
}

class AmbiguousReputationWrite extends Error {}
class ReputationRpcUnavailable extends Error {}

const reviewAttestationAbi = parseAbi([
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
]);
function isReviewExecutionRejection(error: unknown): boolean {
  let current = error;
  for (let depth=0;depth<8 && current && typeof current === "object";depth++) {
    const value = current as {name?:string;code?:number;shortMessage?:string;message?:string;cause?:unknown};
    if (["ExecutionRevertedError","ContractFunctionRevertedError"].includes(value.name ?? "") || value.code === 3 ||
        /execution reverted|reverted with/.test(value.shortMessage ?? value.message ?? "")) return true;
    current = value.cause;
  }
  return false;
}

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
  private readonly broadcastClient;
  private readonly evidenceClients: Array<{ host: string; client: ReturnType<typeof createPublicClient> }>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private nextKind = 0;

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chain: Chain,
    private readonly nonceLock: FacilitatorNonceLock =
      new PostgresFacilitatorNonceLock(
        pool,
        chain.id,
        privateKeyToAccount(config.reputationRelayerPrivateKey).address,
      ),
    private readonly onRecordFinalized: () => void = () => undefined,
    private readonly confirmationState: ConfirmationStateReconciler | null = null,
  ) {
    this.account = privateKeyToAccount(config.reputationRelayerPrivateKey);
    this.broadcastClient = createPublicClient({
      chain,
      transport: http(config.evidenceRpcUrls[0], { retryCount: 0, timeout: 20_000 }),
    });
    this.evidenceClients = config.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: http(url, { retryCount: 0, timeout: 20_000 }),
      }),
    }));
  }
  private observe<Result>(
    work: (endpoint: (typeof this.evidenceClients)[number]) => Promise<Result>,
    terminal?: (error: unknown) => boolean,
  ): Promise<Result> {
    return withRpcFailover(this.evidenceClients, work, {
      terminal,
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("standard reputation RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
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
    const observation = await this.observe(async ({ client }) => {
      const [finalizedNonce, pendingNonce, balance] = await Promise.all([
        client.getTransactionCount({ address: this.account.address, blockTag: "finalized" }),
        client.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
        client.getBalance({ address: this.account.address }),
      ]);
      return {
        finalizedNonce: finalizedNonce.toString(),
        pendingNonce: pendingNonce.toString(),
        balanceWei: balance.toString(),
      };
    }).catch(() => null);
    return {
      chainId: this.chain.id,
      address: this.account.address,
      finalizedNonce: observation?.finalizedNonce ?? null,
      pendingNonce: observation?.pendingNonce ?? null,
      balanceWei: observation?.balanceWei ?? null,
      registerRequiredReserveWei: (this.config.reputationRegisterGasLimit * this.config.reputationMaxFeePerGasWei).toString(),
      confirmationRequiredReserveWei: (this.config.reputationConfirmationGasLimit * this.config.reputationMaxFeePerGasWei).toString(),
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
    await this.reconcileFinalizedConfirmations();
    await this.reconcileParkedReviews();
    const kinds = ["register", "confirmation", "confirmation-v2"] as const;
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

  /** Read chain evidence before an operator retries, including old expired reverts. */
  async reconcileForRetry(operationId: string): Promise<void> {
    await this.nonceLock.run(async () => {
      const operations = await this.pool.query<OperationRow>(
        "SELECT * FROM standard_reputation_operations WHERE operation_id=$1", [operationId],
      );
      const operation = operations.rows[0];
      if (!operation || !["pending", "broadcast", "operator_attention", "authorization_live", "superseded"].includes(operation.state)) return;
      if (operation.kind !== "register") {
        const attempts = await this.pool.query<TransactionRow>(
          "SELECT * FROM standard_reputation_transactions WHERE operation_id=$1 ORDER BY created_at DESC", [operationId]);
        for (const transaction of attempts.rows) {
          if (transaction.state === "final") continue;
          await this.reconcile(operation,transaction,true,false);
          const current = await this.pool.query<{state:string}>("SELECT state FROM standard_reputation_operations WHERE operation_id=$1",[operationId]);
          if (current.rows[0]?.state === "final") break;
        }
        return;
      }
      const transactions = await this.pool.query<TransactionRow>(
        `SELECT * FROM standard_reputation_transactions WHERE operation_id=$1
          ORDER BY created_at DESC LIMIT 1`, [operationId],
      );
      const transaction = transactions.rows[0];
      if (!transaction || transaction.state === "final" ||
          (transaction.state === "failed" && operation.last_error_class !== "contract_rejection")) return;
      if (operation.last_error_class === "contract_rejection") {
        // Revalidate prior expiry evidence; a disappeared/reorged receipt must
        // not leave an old retry authorization behind.
        await this.pool.query(
          "UPDATE standard_reputation_operations SET result=NULL WHERE operation_id=$1 AND last_error_class='contract_rejection'",
          [operationId],
        );
      }
      await this.reconcile(operation, transaction, true, false);
    });
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
      if (operation.kind === "register") await this.reconcile(operation,existing.rows[0]);
      else await this.nonceLock.run(() => this.reconcile(operation,existing.rows[0]!,true));
      return;
    }
    await this.prepareAndBroadcast(operation);
  }

  private async refreshPermitIfNeeded(operation: OperationRow): Promise<OperationRow> {
    if (operation.canonical_intent.operation !== "register-order") return operation;
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

  private async reconcile(
    operation: OperationRow,
    transaction: TransactionRow,
    nonceLocked = false,
    allowBroadcast = true,
  ): Promise<void> {
    let observation;
    try {
      observation = await this.observe(async ({ client }) => {
        let receipt;
        try {
          receipt = await client.getTransactionReceipt({ hash: transaction.transaction_hash });
        } catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        }
        if (!receipt) {
          let pending;
          try {
            pending = await client.getTransaction({ hash: transaction.transaction_hash });
          } catch (error) {
            if (!(error instanceof TransactionNotFoundError)) throw error;
          }
          return {
            receipt: null,
            pending: Boolean(pending),
            head: null,
            canonicalBlock: null,
          };
        }
        const finalHead = operation.kind === "register" ? null : await client.getBlock({ blockTag: this.config.finalityTag });
        const head = finalHead?.number ?? await client.getBlockNumber();
        const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
        return { receipt, pending: false, head, canonicalBlock };
      });
    } catch {
      throw new ReputationRpcUnavailable();
    }
    const { receipt } = observation;
    if (!receipt) {
      if (observation.pending) {
        await this.markBroadcastAndDefer(operation.operation_id, transaction.transaction_id);
        return;
      }
      if (transaction.state !== "failed") {
        await this.broadcastPersisted(operation, transaction, nonceLocked, allowBroadcast);
      }
      return;
    }
    const head = observation.head!;
    if (head < receipt.blockNumber + (operation.kind === "register" ? BigInt(this.config.finalityConfirmations - 1) : 0n)) {
      await this.defer(operation.operation_id);
      return;
    }
    const canonicalBlock = observation.canonicalBlock!;
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
        attestation: operation.kind === "register" ? undefined : await this.readReceiptAttestation(operation, receipt),
      });
      try {
        this.onRecordFinalized();
      } catch {
        // Cache invalidation must never disturb reconciliation.
      }
      const intent = operation.canonical_intent;
      if (intent.operation !== "register-order") {
        // The receipt marked the sponsored submission final; the order's
        // stored confirmation state follows only from a finalized read (spec
        // B7), and the worker keeps reconciling until that read covers the
        // receipt's block, since nothing else refreshes the stored state.
        await this.reconcileConfirmation(operation.operation_id, operation.order_id, intent.orderKey, receipt.blockNumber);
      }
      return;
    }
    const deadline = reputationPermitDeadline(operation.canonical_intent);
    // The mined block, not today's clock, proves this permit was already expired.
    await this.pool.query(
      "UPDATE standard_reputation_operations SET result=$2 WHERE operation_id=$1",
      [operation.operation_id, deadline !== null && canonicalBlock.timestamp > deadline ? {
        rejectionReason: "permit_expired", transactionHash: transaction.transaction_hash,
        blockTimestamp: canonicalBlock.timestamp.toString(), validBefore: deadline.toString(),
      } : null],
    );
    if (transaction.state === "failed") return;
    await this.pool.query(
      "UPDATE standard_reputation_transactions SET state='failed',block_number=$2,block_hash=$3,final_at=now(),updated_at=now() WHERE transaction_id=$1",
      [transaction.transaction_id, receipt.blockNumber.toString(), receipt.blockHash],
    );
    if (operation.kind !== "register") await this.parkReview(operation, "contract_rejection");
    else await this.fail(operation, "contract_rejection");
  }

  private async parkReview(operation: OperationRow, reason: string, state = "operator_attention"): Promise<void> {
    await this.pool.query(
      `UPDATE standard_reputation_operations SET state=$2,last_error_class=$3,
         next_attempt_at=now()+interval '2 minutes',updated_at=now()
       WHERE operation_id=$1 AND state IN ('pending','broadcast','operator_attention','authorization_live')`,
      [operation.operation_id,state,reason],
    );
  }

  /** Called under the shared relayer lock before signing and every send. */
  private async reviewCanSend(
    operation: OperationRow,
    encoded: { data: Hex; destination: Hex; gas: bigint },
    preparing: boolean,
  ): Promise<boolean> {
    if (operation.kind !== "confirmation" && operation.kind !== "confirmation-v2") return true;
    const intent = operation.canonical_intent;
    if (intent.operation === "register-order") throw new Error("REVIEW_INTENT_INVALID");
    const gate = await this.pool.query<{paused:boolean}>("SELECT paused FROM standard_review_control WHERE chain_id=$1",[this.chain.id]);
    if (gate.rows[0]?.paused) { await this.defer(operation.operation_id); return false; }
    const preparation = await this.pool.query<{relay_candidate:boolean;authorization_group:string}>(
      `SELECT p.relay_candidate,p.authorization_group FROM standard_review_preparations p
         JOIN standard_review_sponsorships s ON s.preparation_id=p.preparation_id WHERE s.operation_id=$1`, [operation.operation_id]);
    if (!preparation.rows[0]) { await this.parkReview(operation,"preparation_missing"); return false; }
    if (!preparation.rows[0].relay_candidate) { await this.parkReview(operation,"superseded","superseded"); return false; }
    if (operation.review_relay_until && new Date(operation.review_relay_until).getTime() <= Date.now()) {
      await this.parkReview(operation,"relay_window_expired","authorization_live"); return false;
    }
    if (preparing && operation.kind === "confirmation-v2") {
      const budget = await this.pool.query<{count:string}>(
        `SELECT count(*)::text AS count FROM standard_reputation_transactions t
           JOIN standard_confirmation_sponsorships_v2 s ON s.operation_id=t.operation_id
           JOIN standard_confirmation_preparations_v2 p ON p.preparation_id=s.preparation_id
          WHERE p.authorization_group=$1`, [preparation.rows[0].authorization_group]);
      if (Number(budget.rows[0]?.count ?? 0) >= 5) { await this.parkReview(operation,"authorization_group_budget_exhausted","authorization_live"); return false; }
    }
    try {
      const observed = await this.observe(({client}) => observeEasProfile(client as unknown as PublicClient,this.chain.id,this.config.easAddress), error => error instanceof EasIncompatible);
      const profileId = intent.profileId ?? "eas-native-1.2.0";
      if (observed.profileId !== profileId) { await this.parkReview(operation,"eas_incompatible"); return false; }
      if (signedDeadlineExpired(profileId,intent.request.deadline,BigInt(observed.timestamp))) {
        await this.parkReview(operation,"signed_deadline_expired"); return false;
      }
      await this.observe(({client}) => client.call({account:this.account.address,to:encoded.destination,data:encoded.data,value:0n,gas:encoded.gas}),isReviewExecutionRejection);
      return true;
    } catch (error) {
      if (error instanceof EasIncompatible) { await this.parkReview(operation,"eas_incompatible"); return false; }
      if (isReviewExecutionRejection(error)) { await this.parkReview(operation,"simulation_rejected"); return false; }
      throw new ReputationRpcUnavailable();
    }
  }

  private async readReceiptAttestation(operation: OperationRow, receipt: TransactionReceipt): Promise<ReviewAttestationEvidence> {
    const uid = reviewReceiptUid(receipt,this.config.easAddress,operation.canonical_intent);
    return this.observe(async ({client}) => {
      const evidence = await client.readContract({address:this.config.easAddress,abi:reviewAttestationAbi,
        functionName:"getAttestation",args:[uid],blockNumber:receipt.blockNumber});
      const block = await client.getBlock({blockNumber:receipt.blockNumber});
      if (block.hash !== receipt.blockHash) throw new ReputationRpcUnavailable();
      return evidence;
    });
  }

  /** Parked signatures can still be mined by a previously started send. Read only. */
  private async reconcileParkedReviews(): Promise<void> {
    const operations = await this.pool.query<OperationRow>(
      `SELECT * FROM standard_reputation_operations WHERE kind IN ('confirmation','confirmation-v2')
         AND state IN ('operator_attention','authorization_live','superseded')
         AND (next_attempt_at IS NULL OR next_attempt_at<=now()) ORDER BY updated_at LIMIT 4`);
    for (const operation of operations.rows) {
      try {
        await this.nonceLock.run(async () => {
          const transactions = await this.pool.query<TransactionRow>(
            `SELECT * FROM standard_reputation_transactions WHERE operation_id=$1
              AND state IN ('prepared','broadcast','operator_attention') ORDER BY created_at`,[operation.operation_id]);
          for (const transaction of transactions.rows) await this.reconcile(operation,transaction,true,false);
        });
      } catch { /* Retain the hold and retry only evidence reads. */ }
      await this.pool.query(`UPDATE standard_reputation_operations SET next_attempt_at=now()+interval '2 minutes'
        WHERE operation_id=$1 AND state IN ('operator_attention','authorization_live','superseded')`,[operation.operation_id]);
    }
  }

  private async prepareAndBroadcast(operation: OperationRow): Promise<void> {
    await this.nonceLock.run(async () => {
      const latest = await this.pool.query<OperationRow>(
        "SELECT * FROM standard_reputation_operations WHERE operation_id=$1", [operation.operation_id],
      );
      if (!latest.rows[0] || !["pending", "broadcast"].includes(latest.rows[0].state)) return;
      operation = await this.refreshPermitIfNeeded(latest.rows[0]);
      const encoded = encodeReputationOperation(operation.canonical_intent, this.config);
      if (!(await this.reviewCanSend(operation, encoded, true))) return;
      const client = await this.pool.connect();
      let prepared: TransactionRow | null = null;
      try {
        await client.query("BEGIN");
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
      if (prepared) await this.reconcile(operation, prepared, true);
    });
  }

  private async highestObservedNonce(): Promise<number> {
    try {
      return await this.observe(async ({ client }) => {
        const [latest, pending] = await Promise.all([
          client.getTransactionCount({ address: this.account.address, blockTag: "latest" }),
          client.getTransactionCount({ address: this.account.address, blockTag: "pending" }),
        ]);
        return Math.max(latest, pending);
      });
    } catch {
      throw new ReputationRpcUnavailable();
    }
  }

  private async persistPrepared(
    client: PoolClient,
    operation: OperationRow,
    encoded: { data: Hex; destination: `0x${string}`; gas: bigint },
  ): Promise<TransactionRow> {
    const chainNonce = await this.highestObservedNonce();
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
      updated_at: new Date(),
    };
  }

  private async transactionVisible(hash: Hex): Promise<boolean> {
    try {
      return await this.observe(async ({ client }) => {
        try {
          await client.getTransaction({ hash });
          return true;
        } catch (error) {
          if (error instanceof TransactionNotFoundError) return false;
          throw error;
        }
      });
    } catch {
      throw new ReputationRpcUnavailable();
    }
  }

  private async broadcastPersisted(
    operation: OperationRow,
    transaction: TransactionRow,
    nonceLocked = false,
    allowBroadcast = true,
  ): Promise<void> {
    const submit = async () => {
      // A retry may have retired this row while we waited for the relayer lock.
      const current = await this.pool.query<TransactionRow>(
        "SELECT * FROM standard_reputation_transactions WHERE transaction_id=$1", [transaction.transaction_id],
      );
      if (!current.rows[0] || !["prepared", "broadcast", "operator_attention"].includes(current.rows[0].state)) return;
      transaction = current.rows[0];
      if (await this.transactionVisible(transaction.transaction_hash)) {
        await this.markBroadcastAndDefer(operation.operation_id, transaction.transaction_id);
        return;
      }
      const nonce = Number(transaction.nonce);
      if (!Number.isSafeInteger(nonce)) throw new Error("RELAYER_NONCE_INVALID");
      if (await this.highestObservedNonce() > nonce) {
        await this.resolveNonceConflict(operation, transaction);
        return;
      }
      const currentOperation = await this.pool.query<OperationRow>(
        "SELECT * FROM standard_reputation_operations WHERE operation_id=$1", [operation.operation_id],
      );
      if (!currentOperation.rows[0] || !["pending", "broadcast"].includes(currentOperation.rows[0].state)) return;
      operation = currentOperation.rows[0];
      if (operation.kind === "confirmation" || operation.kind === "confirmation-v2") {
        // An absent receipt never establishes that a signed transaction was dropped.
        // Preserve the journal and replay only its identical bytes after every gate.
        if (!allowBroadcast) return;
        const encoded = encodeReputationOperation(operation.canonical_intent, this.config);
        if (await this.reviewCanSend(operation, encoded, false)) await this.sendPersisted(operation, transaction);
        return;
      }
      const deadline = reputationPermitDeadline(operation.canonical_intent);
      const expired = deadline !== null && deadline <= BigInt(Math.floor(Date.now() / 1_000));
      const missingBroadcast = transaction.state === "broadcast" &&
        Date.now() - transaction.updated_at.getTime() >= this.config.recoveryIntervalMs;
      if (expired || missingBroadcast) {
        await this.pool.query(
          `WITH marked AS (
             UPDATE standard_reputation_transactions SET state='failed',updated_at=now()
              WHERE transaction_id=$2 AND state IN ('prepared','broadcast','operator_attention')
              RETURNING transaction_id
           )
           UPDATE standard_reputation_operations SET
             state=CASE WHEN state='operator_attention' THEN state ELSE 'pending' END,
             last_error_class=$3,next_attempt_at=now(),updated_at=now()
            WHERE operation_id=$1 AND state IN ('pending','broadcast','operator_attention')
              AND EXISTS (SELECT 1 FROM marked)`,
          [operation.operation_id, transaction.transaction_id, expired ? "permit_expired" : "broadcast_not_found"],
        );
        return;
      }
      if (allowBroadcast && transaction.state !== "broadcast") await this.sendPersisted(operation, transaction);
      else await this.defer(operation.operation_id);
    };
    if (nonceLocked) await submit();
    else await this.nonceLock.run(submit);
  }

  private async sendPersisted(operation: OperationRow, transaction: TransactionRow): Promise<void> {
    const raw = decryptRaw(
      transaction.encrypted_raw_transaction,
      this.config.encryptionKey,
      operation.operation_id,
    );
    if (operation.kind === "confirmation" || operation.kind === "confirmation-v2") {
      const encoded = encodeReputationOperation(operation.canonical_intent,this.config);
      const decoded = parseTransaction(raw);
      if (keccak256(raw) !== transaction.transaction_hash || decoded.chainId !== this.chain.id || (decoded.value ?? 0n) !== 0n ||
          decoded.to?.toLowerCase() !== encoded.destination.toLowerCase() || decoded.data?.toLowerCase() !== encoded.data.toLowerCase()) {
        await this.parkReview(operation,"transaction_intent_mismatch"); return;
      }
    }
    try {
      const submitted = await this.broadcastClient.sendRawTransaction({
        serializedTransaction: raw,
      });
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
        const signed = parseTransaction(raw);
        logger.warn("standard reputation fee reserve required", {
          operationId: operation.operation_id,
          reason: "balance_fee",
          chainId: this.chain.id,
          relayerAddress: this.account.address,
          gasLimit: signed.gas?.toString(),
          maxFeePerGasWei: signed.maxFeePerGas?.toString(),
          requiredReserveWei: ((signed.gas ?? 0n) * (signed.maxFeePerGas ?? 0n) + (signed.value ?? 0n)).toString(),
        });
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

  /**
   * Finalized confirmation operations whose stored order state does not yet
   * cover their receipt: each batch retries them until the finalized anchor
   * has caught up, then marks them reconciled.
   */
  private async reconcileFinalizedConfirmations(): Promise<void> {
    if (!this.confirmationState) return;
    const due = await this.pool.query<OperationRow & { final_block_number: string }>(
      `SELECT * FROM standard_reputation_operations
        WHERE kind IN ('confirmation','confirmation-v2') AND state='final' AND confirmation_reconciled_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at<=now())
        ORDER BY updated_at LIMIT 3`,
    );
    for (const operation of due.rows) {
      const intent = operation.canonical_intent;
      if (intent.operation === "register-order" || operation.final_block_number === null) continue;
      await this.reconcileConfirmation(
        operation.operation_id, operation.order_id, intent.orderKey, BigInt(operation.final_block_number),
      );
    }
  }

  private async reconcileConfirmation(operationId: string, orderId: string, orderKey: Hex, receiptBlock: bigint): Promise<void> {
    if (!this.confirmationState) return;
    let covered = false;
    try {
      const outcome = await this.confirmationState.reconcile({ orderId, orderKey });
      covered = BigInt(outcome.final.blockNumber) >= receiptBlock;
    } catch (error) {
      logger.warn("confirmation state reconciliation deferred", {
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.pool.query(covered
      ? `UPDATE standard_reputation_operations
            SET confirmation_reconciled_at=now(),next_attempt_at=NULL,updated_at=now()
          WHERE operation_id=$1`
      : `UPDATE standard_reputation_operations
            SET next_attempt_at=now()+interval '2 minutes',updated_at=now()
          WHERE operation_id=$1 AND state='final'`,
      [operationId]);
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
    let receipt;
    let finalizedNonce;
    try {
      receipt = await this.observe(async ({ client }) => {
        try {
          return await client.getTransactionReceipt({ hash: transaction.transaction_hash });
        } catch (error) {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        }
      });
      // The nonce floor is read at the configured finality tag: a transaction
      // whose nonce is already consumed there was replaced, not delayed.
      finalizedNonce = receipt ? null : await this.observe(({ client }) =>
        client.getTransactionCount({ address: this.account.address, blockTag: this.config.finalityTag }));
    } catch {
      throw new ReputationRpcUnavailable();
    }
    if (receipt) {
      await this.reconcile(operation, transaction);
      return;
    }
    if (hasFinalizedNonceConflict([BigInt(finalizedNonce!)], BigInt(transaction.nonce))) {
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
    const attempts = Math.min(5, operation.attempts + 1);
    const terminal = attempts >= 5;
    const delay = terminal ? null : this.config.reputationRetryDelaysSeconds[attempts - 1]!;
    if (terminal && transactionId && operation.kind !== "confirmation" && operation.kind !== "confirmation-v2") {
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
