import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
import type { PoolClient } from "pg";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";

const events = parseAbi([
  "event StandardOrderRegistered(bytes32 indexed orderKey,bytes32 indexed authorizationKey,uint256 indexed providerAgentId,bytes32 serviceId,address payer,uint256 grossAmount,bool reputationEligible)",
  "event OutcomeRecorded(bytes32 indexed orderKey,uint256 indexed providerAgentId,address indexed payer,bytes32 serviceId,uint8 outcome,uint256 attestationDelay,bytes32 attestationUid)",
  "event BuyerConfirmationSubmitted(bytes32 indexed orderKey,uint256 indexed providerAgentId,address indexed payer,bytes32 serviceId,uint8 confirmation,bytes32 attestationUid,bytes32 refUid,uint8 transitionCount)",
  "event BuyerConfirmationRevoked(bytes32 indexed orderKey,bytes32 indexed attestationUid,address indexed payer,uint8 transitionCount)",
  "event ReputationRefunded(bytes32 indexed orderKey,bytes32 indexed serviceId,uint256 delta,uint256 cumulativeRefunded,bytes32 refundEvidenceHash)",
]);

const readAbi = parseAbi([
  "function getRecordCount() view returns (uint256)",
  "function recordKeys(uint256) view returns (bytes32)",
  "function refundedAmount(bytes32) view returns (uint256)",
  "function getRecord(bytes32) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationTransitions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
]);

const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const bytes = (value: Hex): Buffer => Buffer.from(value.slice(2), "hex");

interface ProjectionState {
  chain_id: string;
  contract_address: string;
  deployment_block: string;
  last_indexed_block: string;
  last_indexed_block_hash: string | null;
  terminal_error_class: string | null;
  recovery_scan_index: string;
}

interface ChainRecord {
  orderKey: Hex;
  authorizationKey: Hex;
  providerAgentId: bigint;
  serviceId: Hex;
  payer: Hex;
  grossAmount: bigint;
  paidAt: bigint;
  outcome: number;
  confirmation: number;
  outcomeAttestationDelay: bigint;
  outcomeTimestamp: bigint;
  confirmationTimestamp: bigint;
  confirmationTransitions: number;
  outcomeRecorded: boolean;
  reputationEligible: boolean;
  currentConfirmationUid: Hex;
}

interface ProjectedRecord { record: ChainRecord; refunded: bigint; blockNumber: bigint }

interface ProjectionLog {
  transactionHash: Hex | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  eventName: "StandardOrderRegistered" | "OutcomeRecorded" |
    "BuyerConfirmationSubmitted" | "BuyerConfirmationRevoked" | "ReputationRefunded";
  args: { orderKey: Hex };
}

export class StandardReputationIndexer {
  private readonly client;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastSuccessAt: number | null = null;
  private safeHead: bigint | null = null;
  private lastIndexed: bigint | null = null;
  private chainRecordCount: bigint | null = null;
  private projectedRecordCount: bigint | null = null;
  private failure: { category: string; at: string } | null = null;
  private terminal = false;

  constructor(
    private readonly pool: Pool,
    private readonly config: StandardRailConfig,
    private readonly chain: Chain,
  ) {
    this.client = createPublicClient({
      chain,
      transport: fallback(config.evidenceRpcUrls.map(
        (url) => http(url, { retryCount: 0, timeout: 20_000 }),
      )),
    });
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.tick();
    this.timer = setInterval(() => void this.schedule(), this.config.recoveryIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  isReady(now = Date.now()): boolean {
    return !this.terminal && this.failure === null && this.lastSuccessAt !== null &&
      now - this.lastSuccessAt <= this.config.recoveryIntervalMs * 6 && this.lagBlocks() === 0n &&
      this.chainRecordCount !== null && this.chainRecordCount === this.projectedRecordCount;
  }

  status(): Record<string, unknown> {
    return {
      ready: this.isReady(),
      deploymentBlock: this.config.reputationDeploymentBlock.toString(),
      lastIndexedBlock: this.lastIndexed?.toString() ?? null,
      safeHead: this.safeHead?.toString() ?? null,
      lagBlocks: this.lagBlocks()?.toString() ?? null,
      chainRecordCount: this.chainRecordCount?.toString() ?? null,
      projectedRecordCount: this.projectedRecordCount?.toString() ?? null,
      recordCountMatches: this.chainRecordCount !== null &&
        this.chainRecordCount === this.projectedRecordCount,
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      failure: this.failure,
      terminal: this.terminal,
    };
  }

  private schedule(): void {
    if (this.running || this.terminal) return;
    this.running = this.tick().finally(() => { this.running = null; });
  }

  private async tick(): Promise<void> {
    const db = await this.pool.connect();
    try {
      const lock = await db.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        ["standard:reputation-projection"],
      );
      if (!lock.rows[0]?.acquired) return;
      try {
        let state = await this.initialize(db);
        const head = await this.client.getBlockNumber();
        const offset = BigInt(this.config.finalityConfirmations - 1);
        const safeHead = head > offset ? head - offset : 0n;
        this.safeHead = safeHead;
        state = await this.reconcileCanonicalCursor(db, state);
        await this.indexTo(db, state, safeHead);
        const count = safeHead < this.config.reputationDeploymentBlock
          ? 0n
          : await this.client.readContract({ address: this.config.reputationContract,
              abi: readAbi, functionName: "getRecordCount", blockNumber: safeHead });
        const projected = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM standard_reputation_projection_records",
        );
        this.chainRecordCount = BigInt(count);
        this.projectedRecordCount = BigInt(projected.rows[0]?.count ?? "0");
        if (this.projectedRecordCount > this.chainRecordCount) {
          throw new Error("PROJECTION_INTEGRITY_RECORD_COUNT");
        }
        if (this.projectedRecordCount < this.chainRecordCount) {
          await this.recoverMissingRecords(db, safeHead, this.chainRecordCount);
          const recovered = await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM standard_reputation_projection_records",
          );
          this.projectedRecordCount = BigInt(recovered.rows[0]?.count ?? "0");
        }
        this.lastSuccessAt = Date.now();
        this.failure = null;
      } finally {
        await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          "standard:reputation-projection",
        ]).catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = /PROJECTION_(DESCRIPTOR|INTEGRITY)/.test(message);
      this.terminal = terminal;
      this.failure = { category: terminal ? "projection_integrity" : "rpc", at: new Date().toISOString() };
      logger.error("standard reputation projection became unhealthy", {
        category: this.failure.category,
        error,
      });
      if (terminal) await this.markTerminal(message).catch(() => undefined);
    } finally { db.release(); }
  }

  private async initialize(db: PoolClient): Promise<ProjectionState> {
    const deployment = this.config.reputationDeploymentBlock;
    await db.query(
      `INSERT INTO standard_reputation_projection_state
        (chain_id,contract_address,deployment_block,last_indexed_block)
       VALUES ($1,$2,$3,$4) ON CONFLICT (singleton) DO NOTHING`,
      [this.chain.id, this.config.reputationContract.toLowerCase(), deployment.toString(),
        (deployment - 1n).toString()],
    );
    const result = await db.query<ProjectionState>(
      "SELECT * FROM standard_reputation_projection_state WHERE singleton=true",
    );
    const state = result.rows[0];
    if (!state || BigInt(state.chain_id) !== BigInt(this.chain.id) ||
      getAddress(state.contract_address) !== getAddress(this.config.reputationContract) ||
      BigInt(state.deployment_block) !== deployment || state.terminal_error_class) {
      throw new Error("PROJECTION_DESCRIPTOR_MISMATCH");
    }
    this.lastIndexed = BigInt(state.last_indexed_block);
    return state;
  }

  private async indexTo(db: PoolClient, initial: ProjectionState, safeHead: bigint): Promise<void> {
    let cursor = BigInt(initial.last_indexed_block);
    const deployment = this.config.reputationDeploymentBlock;
    if (safeHead < deployment || cursor >= safeHead) return;
    let from = cursor < deployment ? deployment : cursor + 1n;
    while (from <= safeHead) {
      const to = from + 499n > safeHead ? safeHead : from + 499n;
      const logs = await this.client.getLogs({
        address: this.config.reputationContract,
        events,
        fromBlock: from,
        toBlock: to,
        strict: true,
      }) as unknown as ProjectionLog[];
      if (logs.length > 5_000) throw new Error("PROJECTION_INTEGRITY_PAGE_LIMIT");
      const keys = [...new Set(logs.map((log) => String(log.args.orderKey).toLowerCase()))] as Hex[];
      const records: ProjectedRecord[] = [];
      for (const key of keys) {
        const record = await this.readRecord(key, to);
        if (!record) throw new Error("PROJECTION_INTEGRITY_MISSING_RECORD");
        records.push(record);
      }
      const block = await this.client.getBlock({ blockNumber: to });
      if (!block.hash) throw new Error("PROJECTION_INTEGRITY_BLOCK_HASH");
      await this.applyPage(db, from, to, block.hash, logs, records);
      cursor = to;
      from = to + 1n;
      this.lastIndexed = cursor;
    }
  }

  private async readRecord(orderKey: Hex, blockNumber: bigint): Promise<ProjectedRecord | null> {
    const [raw, refunded] = await Promise.all([
      this.client.readContract({ address: this.config.reputationContract, abi: readAbi,
        functionName: "getRecord", args: [orderKey], blockNumber }),
      this.client.readContract({ address: this.config.reputationContract, abi: readAbi,
        functionName: "refundedAmount", args: [orderKey], blockNumber }),
    ]);
    const record = raw as unknown as ChainRecord;
    if (record.orderKey.toLowerCase() === ZERO_HASH) return null;
    if (record.orderKey.toLowerCase() !== orderKey.toLowerCase() || record.providerAgentId === 0n ||
      record.serviceId === ZERO_HASH || record.grossAmount === 0n || Number(record.confirmation) > 2 ||
      Number(record.outcome) > 2 || Number(record.confirmationTransitions) > 3 ||
      BigInt(refunded) > record.grossAmount) throw new Error("PROJECTION_INTEGRITY_RECORD");
    return { record, refunded: BigInt(refunded), blockNumber };
  }

  private async applyPage(
    db: PoolClient,
    from: bigint,
    to: bigint,
    blockHash: Hex,
    logs: ProjectionLog[],
    records: ProjectedRecord[],
  ): Promise<void> {
    await db.query("BEGIN");
    try {
      const state = await db.query<ProjectionState>(
        "SELECT * FROM standard_reputation_projection_state WHERE singleton=true FOR UPDATE",
      );
      if (BigInt(state.rows[0]!.last_indexed_block) !== from - 1n) {
        throw new Error("PROJECTION_INTEGRITY_CURSOR_RACE");
      }
      for (const log of logs) {
        if (!log.transactionHash || log.logIndex === null || log.blockNumber === null || !log.blockHash ||
          !log.eventName || !log.args.orderKey) throw new Error("PROJECTION_INTEGRITY_LOG");
        await db.query(
          `INSERT INTO standard_reputation_projection_events
            (transaction_hash,log_index,block_number,block_hash,order_key,event_name)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [log.transactionHash.toLowerCase(), log.logIndex, log.blockNumber.toString(),
            log.blockHash.toLowerCase(), bytes(String(log.args.orderKey).toLowerCase() as Hex), log.eventName],
        );
      }
      for (const record of records) await this.upsertRecord(db, record);
      await db.query(
        `INSERT INTO standard_reputation_projection_blocks(block_number,block_hash)
         VALUES ($1,$2) ON CONFLICT (block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash`,
        [to.toString(), blockHash.toLowerCase()],
      );
      await db.query(
        `UPDATE standard_reputation_projection_state SET last_indexed_block=$1,
          last_indexed_block_hash=$2,last_success_at=now(),updated_at=now() WHERE singleton=true`,
        [to.toString(), blockHash.toLowerCase()],
      );
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
  }

  private async upsertRecord(db: PoolClient, projected: ProjectedRecord): Promise<void> {
    const row = projected.record;
    await db.query(
      `INSERT INTO standard_reputation_projection_records
        (order_key,authorization_key,provider_agent_id,service_id,payer,gross_amount,paid_at,
         outcome,confirmation,outcome_attestation_delay,outcome_timestamp,confirmation_timestamp,
         confirmation_transitions,outcome_recorded,reputation_eligible,current_confirmation_uid,
         cumulative_refunded,last_event_block)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (order_key) DO UPDATE SET authorization_key=EXCLUDED.authorization_key,
         provider_agent_id=EXCLUDED.provider_agent_id,service_id=EXCLUDED.service_id,payer=EXCLUDED.payer,
         gross_amount=EXCLUDED.gross_amount,paid_at=EXCLUDED.paid_at,outcome=EXCLUDED.outcome,
         confirmation=EXCLUDED.confirmation,outcome_attestation_delay=EXCLUDED.outcome_attestation_delay,
         outcome_timestamp=EXCLUDED.outcome_timestamp,confirmation_timestamp=EXCLUDED.confirmation_timestamp,
         confirmation_transitions=EXCLUDED.confirmation_transitions,outcome_recorded=EXCLUDED.outcome_recorded,
         reputation_eligible=EXCLUDED.reputation_eligible,
         current_confirmation_uid=EXCLUDED.current_confirmation_uid,
         cumulative_refunded=EXCLUDED.cumulative_refunded,last_event_block=EXCLUDED.last_event_block,
         updated_at=now()`,
      [bytes(row.orderKey), bytes(row.authorizationKey), row.providerAgentId.toString(), bytes(row.serviceId),
        getAddress(row.payer).toLowerCase(), row.grossAmount.toString(), row.paidAt.toString(),
        row.outcomeRecorded ? Number(row.outcome) : null, Number(row.confirmation),
        row.outcomeRecorded ? row.outcomeAttestationDelay.toString() : null,
        row.outcomeTimestamp.toString(), row.confirmationTimestamp.toString(),
        Number(row.confirmationTransitions), row.outcomeRecorded, row.reputationEligible,
        bytes(row.currentConfirmationUid), projected.refunded.toString(), projected.blockNumber.toString()],
    );
  }

  private async recoverMissingRecords(
    db: PoolClient,
    blockNumber: bigint,
    recordCount: bigint,
  ): Promise<void> {
    const state = await db.query<{ recovery_scan_index: string }>(
      "SELECT recovery_scan_index::text FROM standard_reputation_projection_state WHERE singleton=true",
    );
    let start = BigInt(state.rows[0]?.recovery_scan_index ?? "0");
    if (start >= recordCount) start = 0n;
    const end = start + 250n > recordCount ? recordCount : start + 250n;
    const recovered: ProjectedRecord[] = [];
    for (let index = start; index < end; index += 1n) {
      const orderKey = await this.client.readContract({
        address: this.config.reputationContract,
        abi: readAbi,
        functionName: "recordKeys",
        args: [index],
        blockNumber,
      });
      const present = await db.query(
        "SELECT 1 FROM standard_reputation_projection_records WHERE order_key=$1",
        [bytes(orderKey)],
      );
      if (present.rowCount) continue;
      const record = await this.readRecord(orderKey, blockNumber);
      if (!record) throw new Error("PROJECTION_INTEGRITY_MISSING_RECORD");
      recovered.push(record);
    }
    await db.query("BEGIN");
    try {
      for (const record of recovered) await this.upsertRecord(db, record);
      await db.query(
        `UPDATE standard_reputation_projection_state SET recovery_scan_index=$1,
          updated_at=now() WHERE singleton=true`,
        [(end === recordCount ? 0n : end).toString()],
      );
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
    if (recovered.length > 0) {
      logger.warn("standard reputation projection recovered missing records", {
        recoveredRecords: recovered.length,
        scanStart: start.toString(),
        scanEnd: end.toString(),
      });
    }
  }

  private async reconcileCanonicalCursor(db: PoolClient, state: ProjectionState): Promise<ProjectionState> {
    const last = BigInt(state.last_indexed_block);
    if (last < this.config.reputationDeploymentBlock || !state.last_indexed_block_hash) return state;
    const canonical = await this.client.getBlock({ blockNumber: last }).catch(() => null);
    if (canonical?.hash.toLowerCase() === state.last_indexed_block_hash.toLowerCase()) return state;
    const checkpoints = await db.query<{ block_number: string; block_hash: string }>(
      `SELECT block_number::text,block_hash FROM standard_reputation_projection_blocks
        WHERE block_number<$1 ORDER BY block_number DESC LIMIT 32`,
      [last.toString()],
    );
    let ancestor = this.config.reputationDeploymentBlock - 1n;
    let ancestorHash: string | null = null;
    for (const checkpoint of checkpoints.rows) {
      const block = await this.client.getBlock({ blockNumber: BigInt(checkpoint.block_number) }).catch(() => null);
      if (block?.hash.toLowerCase() === checkpoint.block_hash.toLowerCase()) {
        ancestor = BigInt(checkpoint.block_number);
        ancestorHash = checkpoint.block_hash;
        break;
      }
    }
    const affected = await db.query<{ order_key: Buffer }>(
      "SELECT DISTINCT order_key FROM standard_reputation_projection_events WHERE block_number>$1",
      [ancestor.toString()],
    );
    const restored = new Map<string, ProjectedRecord | null>();
    for (const item of affected.rows) {
      const key = `0x${item.order_key.toString("hex")}` as Hex;
      restored.set(key, ancestor < this.config.reputationDeploymentBlock
        ? null : await this.readRecord(key, ancestor));
    }
    await db.query("BEGIN");
    try {
      await db.query("DELETE FROM standard_reputation_projection_events WHERE block_number>$1", [ancestor.toString()]);
      await db.query("DELETE FROM standard_reputation_projection_blocks WHERE block_number>$1", [ancestor.toString()]);
      for (const [key, record] of restored) {
        if (record) await this.upsertRecord(db, record);
        else await db.query("DELETE FROM standard_reputation_projection_records WHERE order_key=$1", [bytes(key as Hex)]);
      }
      await db.query(
        `UPDATE standard_reputation_projection_state SET last_indexed_block=$1,
          last_indexed_block_hash=$2,updated_at=now() WHERE singleton=true`,
        [ancestor.toString(), ancestorHash],
      );
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK").catch(() => undefined); throw error; }
    logger.warn("standard reputation projection rewound a non-canonical cursor", {
      fromBlock: last.toString(),
      toBlock: ancestor.toString(),
      affectedRecords: affected.rowCount ?? 0,
    });
    const refreshed = await db.query<ProjectionState>(
      "SELECT * FROM standard_reputation_projection_state WHERE singleton=true",
    );
    this.lastIndexed = ancestor;
    return refreshed.rows[0]!;
  }

  private lagBlocks(): bigint | null {
    if (this.safeHead === null || this.lastIndexed === null) return null;
    const target = this.safeHead < this.config.reputationDeploymentBlock
      ? this.config.reputationDeploymentBlock - 1n : this.safeHead;
    return target > this.lastIndexed ? target - this.lastIndexed : 0n;
  }

  private async markTerminal(message: string): Promise<void> {
    await this.pool.query(
      `UPDATE standard_reputation_projection_state SET terminal_error_class=$1,
        terminal_error_at=now(),updated_at=now() WHERE singleton=true`,
      [message.slice(0, 128)],
    );
  }
}
