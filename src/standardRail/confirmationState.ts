import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Pool } from "../db/pool.js";
import { withRpcFailover } from "../rpc/failover.js";
import { logger } from "../util/logger.js";
import type { StandardRailConfig } from "./config.js";

export const ZERO_UID = `0x${"00".repeat(32)}` as Hex;

export const reputationReadsAbi = parseAbi([
  "function getRecord(bytes32 orderKey) view returns ((bytes32 orderKey,bytes32 authorizationKey,uint256 providerAgentId,bytes32 serviceId,address payer,address providerOwner,address providerAgentWallet,address providerPayee,address canonicalToken,uint256 grossAmount,uint64 paidAt,bytes32 providerIdentitySnapshotHash,bytes32 listingManifestHash,bytes32 releaseEvidenceHash,uint8 outcome,uint8 confirmation,uint64 outcomeAttestationDelay,uint64 outcomeTimestamp,uint64 confirmationTimestamp,uint8 confirmationSubmissions,bool outcomeRecorded,bool reputationEligible,bytes32 currentConfirmationUid))",
]);

export type ConfirmationLabel = "Pending" | "Confirmed" | "NotConfirmed";

/** The order's confirmation state as stored: finalized reads only. */
export interface ConfirmationFinal {
  state: ConfirmationLabel;
  currentUid: Hex;
  submissionsUsed: number;
  blockNumber: string;
  blockHash: Hex;
}

/** One `getRecord` read pinned to a block hash. */
export interface ConfirmationObservation extends ConfirmationFinal {
  registered: boolean;
  payer: Address;
  providerOwner: Address;
  providerAgentWallet: Address;
}

/** The viem client surface one observation needs; mocked in tests. */
export interface ConfirmationReadClient {
  getBlock(args: { blockTag: "finalized" | "latest" }): Promise<{ number: bigint; hash: Hex }>;
  readContract(args: {
    address: Address;
    abi: typeof reputationReadsAbi;
    functionName: "getRecord";
    args: readonly [Hex];
    blockHash: Hex;
  }): Promise<unknown>;
}

interface StoredRow {
  current_uid: Buffer | null;
  confirmation: ConfirmationLabel;
  submissions_used: number;
  finalized_block: string;
  finalized_block_hash: string;
}

export function confirmationLabel(value: number | bigint): ConfirmationLabel {
  const code = Number(value);
  return code === 1 ? "Confirmed" : code === 2 ? "NotConfirmed" : "Pending";
}

function rowToFinal(row: StoredRow): ConfirmationFinal {
  return {
    state: row.confirmation,
    currentUid: row.current_uid ? (`0x${row.current_uid.toString("hex")}` as Hex) : ZERO_UID,
    submissionsUsed: Number(row.submissions_used),
    blockNumber: String(row.finalized_block),
    blockHash: row.finalized_block_hash as Hex,
  };
}

/**
 * The durable confirmation state of an order (spec B7): written only from a
 * `getRecord` read pinned by block hash to the block the `finalized` tag
 * returned, and only when that block is higher than the stored one. A
 * `latest` read is returned to callers but never stored. The capability
 * epoch moves only when the stored state or current UID changes.
 */
export class StandardConfirmationState {
  private readonly clients: Array<{ host: string; client: ConfirmationReadClient }>;
  private readonly reputationContract: Address;

  constructor(
    private readonly pool: Pool,
    config: Pick<StandardRailConfig, "evidenceRpcUrls" | "reputationContract">,
    chain: Chain,
    private readonly bumpEpoch: (orderId: string) => Promise<void>,
    clients?: Array<{ host: string; client: ConfirmationReadClient }>,
  ) {
    this.reputationContract = config.reputationContract;
    this.clients = clients ?? config.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: http(url, { retryCount: 0, timeout: 20_000 }),
      }) as unknown as ConfirmationReadClient,
    }));
  }

  /** Runs one chain read through the state's endpoints with the shared failover. */
  observeWith<Result>(
    work: (endpoint: { host: string; client: ConfirmationReadClient }) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("confirmation state RPC fallback selected", { primaryHost, selectedHost });
      },
    });
  }

  /** Moves the order's capability epoch; called only when the stored state changed. */
  bumpEpochFor(orderId: string): Promise<void> {
    return this.bumpEpoch(orderId);
  }

  /** One read of the order's record at the given tag, pinned to that block's hash. */
  async observe(orderKey: Hex, tag: "finalized" | "latest"): Promise<ConfirmationObservation> {
    return withRpcFailover(this.clients, async ({ client }) => {
      const block = await client.getBlock({ blockTag: tag });
      const record = await client.readContract({
        address: this.reputationContract,
        abi: reputationReadsAbi,
        functionName: "getRecord",
        args: [orderKey],
        blockHash: block.hash,
      }) as {
        orderKey: Hex;
        payer: Address;
        providerOwner: Address;
        providerAgentWallet: Address;
        confirmation: number;
        confirmationSubmissions: number;
        currentConfirmationUid: Hex;
      };
      return {
        registered: record.orderKey.toLowerCase() !== ZERO_UID,
        payer: record.payer,
        providerOwner: record.providerOwner,
        providerAgentWallet: record.providerAgentWallet,
        state: confirmationLabel(record.confirmation),
        currentUid: record.currentConfirmationUid.toLowerCase() as Hex,
        submissionsUsed: Number(record.confirmationSubmissions),
        blockNumber: block.number.toString(),
        blockHash: block.hash.toLowerCase() as Hex,
      };
    }, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("confirmation state RPC fallback selected", { primaryHost, selectedHost });
      },
    });
  }

  async stored(orderId: string): Promise<ConfirmationFinal | null> {
    const result = await this.pool.query<StoredRow>(
      `SELECT current_uid,confirmation,submissions_used,finalized_block::text,finalized_block_hash
         FROM standard_reputation_confirmations WHERE order_id=$1`,
      [orderId],
    );
    return result.rows[0] ? rowToFinal(result.rows[0]) : null;
  }

  /**
   * Stores a finalized observation when its block is higher than the stored
   * one. Reports whether anything was written and whether the state or the
   * current UID changed, which is what moves the capability epoch.
   *
   * Concurrent first observations serialize on a per-order advisory lock:
   * `FOR UPDATE` cannot lock a row that does not exist yet, so without it two
   * first writers both read absence and the later insert would overwrite the
   * higher block. The upsert itself is also conditional on a higher block, so
   * storage is monotonic whatever the interleaving, and every result is
   * derived from the row the database actually holds.
   */
  async record(
    order: { orderId: string; orderKey: Hex },
    observation: ConfirmationFinal,
  ): Promise<{ stored: boolean; changed: boolean; final: ConfirmationFinal }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('confirmation-state:' || $1::text, 0))",
        [order.orderId],
      );
      const existing = await client.query<StoredRow>(
        `SELECT current_uid,confirmation,submissions_used,finalized_block::text,finalized_block_hash
           FROM standard_reputation_confirmations WHERE order_id=$1 FOR UPDATE`,
        [order.orderId],
      );
      const current = existing.rows[0] ? rowToFinal(existing.rows[0]) : null;
      if (current && BigInt(current.blockNumber) >= BigInt(observation.blockNumber)) {
        await client.query("COMMIT");
        return { stored: false, changed: false, final: current };
      }
      const uid = observation.currentUid.toLowerCase() === ZERO_UID
        ? null
        : Buffer.from(observation.currentUid.slice(2), "hex");
      const written = await client.query<StoredRow>(
        `INSERT INTO standard_reputation_confirmations
          (order_id,order_key,current_uid,confirmation,submissions_used,finalized_block,finalized_block_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (order_id) DO UPDATE SET current_uid=EXCLUDED.current_uid,
           confirmation=EXCLUDED.confirmation,submissions_used=EXCLUDED.submissions_used,
           finalized_block=EXCLUDED.finalized_block,finalized_block_hash=EXCLUDED.finalized_block_hash,
           updated_at=now()
         WHERE standard_reputation_confirmations.finalized_block < EXCLUDED.finalized_block
         RETURNING current_uid,confirmation,submissions_used,finalized_block::text,finalized_block_hash`,
        [order.orderId, Buffer.from(order.orderKey.slice(2), "hex"), uid, observation.state,
          observation.submissionsUsed, observation.blockNumber, observation.blockHash],
      );
      if (!written.rows[0]) {
        // Unreachable under the lock; kept so storage stays monotonic even if
        // a writer bypassed it. Report the row as the database holds it.
        const held = await client.query<StoredRow>(
          `SELECT current_uid,confirmation,submissions_used,finalized_block::text,finalized_block_hash
             FROM standard_reputation_confirmations WHERE order_id=$1`,
          [order.orderId],
        );
        await client.query("COMMIT");
        const row = held.rows[0];
        if (!row) throw new Error("confirmation state vanished under the lock");
        return { stored: false, changed: false, final: rowToFinal(row) };
      }
      await client.query("COMMIT");
      const stored = rowToFinal(written.rows[0]);
      const changed = !current ||
        current.state !== stored.state ||
        current.currentUid.toLowerCase() !== stored.currentUid.toLowerCase();
      return { stored: true, changed, final: stored };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** One finalized read written through the storage rule; bumps the epoch on change. */
  async reconcile(order: { orderId: string; orderKey: Hex }): Promise<{
    final: ConfirmationFinal;
    changed: boolean;
  }> {
    const observation = await this.observe(order.orderKey, "finalized");
    const outcome = await this.record(order, observation);
    if (outcome.changed) await this.bumpEpoch(order.orderId);
    return { final: outcome.final, changed: outcome.changed };
  }
}

