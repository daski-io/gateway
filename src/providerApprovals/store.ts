import type { PoolClient } from "pg";
import type { Hex } from "viem";
import type { Pool } from "../db/pool.js";
import { canonicalHash } from "../standardRail/canonical.js";
import { logger } from "../util/logger.js";
import type { ProviderApprovalRecord } from "./record.js";

/// standard_provider_approvals (migration 063): one current approval per
/// provider and chain, older and revoked rows kept. The catalog reads current
/// approvals through a snapshot shared by the process: a write here replaces
/// it at once, and a write by another replica is seen once the snapshot is
/// older than SNAPSHOT_TTL_MS.

/** How long the catalog's snapshot of current approvals is reused. */
export const APPROVAL_SNAPSHOT_TTL_MS = 30_000;
/** After a failed reload, the previous snapshot is served this long before the next attempt. */
const APPROVAL_SNAPSHOT_RETRY_MS = 5_000;

export interface ProviderApproval {
  approvalId: string;
  providerAgentId: string;
  chainId: number;
  approvedAt: Date;
  approvedBy: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  record: ProviderApprovalRecord;
  recordHash: Hex;
}

/** An operator action recorded with the change, in its transaction. */
export interface ProviderApprovalAudit {
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

/** What the catalog reads: the current approval record of a provider. */
export interface ProviderApprovalReader {
  /** Moves whenever this process sees the set of current approvals change. */
  readonly version: number;
  currentRecord(providerAgentId: string): Promise<ProviderApprovalRecord | null>;
  recordByHash(hash: string): Promise<ProviderApprovalRecord | null>;
}

interface ApprovalRow {
  approval_id: string;
  provider_agent_id: string;
  chain_id: string;
  approved_at: Date;
  approved_by: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  record_json: ProviderApprovalRecord;
  record_hash: Buffer;
}

// approval_id is answered as text: ORDER BY names the table's column, never this alias.
const COLUMNS = `approval_id::text AS approval_id,provider_agent_id,chain_id::text AS chain_id,approved_at,
  approved_by,revoked_at,revoked_by,record_json,record_hash`;

const bytes = (value: string): Buffer => Buffer.from(value.slice(2), "hex");

/** A row whose stored record no longer hashes to its record hash is never served. */
function mapRow(row: ApprovalRow): ProviderApproval | null {
  const recordHash = `0x${row.record_hash.toString("hex")}` as Hex;
  if (canonicalHash(row.record_json) !== recordHash) {
    logger.error("provider approval record does not match its hash", {
      providerAgentId: row.provider_agent_id, approvalId: row.approval_id,
    });
    return null;
  }
  return {
    approvalId: row.approval_id,
    providerAgentId: row.provider_agent_id,
    chainId: Number(row.chain_id),
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    record: row.record_json,
    recordHash,
  };
}

export class ProviderApprovalStore implements ProviderApprovalReader {
  private snapshot: { expiresAt: number; fingerprint: string; byProvider: Map<string, ProviderApproval> } | null = null;
  private loading: Promise<Map<string, ProviderApproval>> | null = null;
  /** Bumped by every local write: a read started before it never becomes the snapshot. */
  private generation = 0;
  private changes = 0;

  constructor(
    private readonly pool: Pool,
    private readonly chainId: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get version(): number {
    return this.changes;
  }

  /** Forgets the snapshot, so the next catalog read sees the database. */
  invalidate(): void {
    this.generation += 1;
    this.snapshot = null;
    this.loading = null;
    this.changes += 1;
  }

  /** The provider's current approval, from the snapshot. */
  async current(providerAgentId: string): Promise<ProviderApproval | null> {
    return (await this.currentApprovals()).get(providerAgentId) ?? null;
  }

  async currentRecord(providerAgentId: string): Promise<ProviderApprovalRecord | null> {
    return (await this.current(providerAgentId))?.record ?? null;
  }

  /** The provider's current approval, read from the database now. */
  async read(providerAgentId: string): Promise<ProviderApproval | null> {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM standard_provider_approvals
        WHERE provider_agent_id=$1 AND chain_id=$2 AND revoked_at IS NULL`,
      [providerAgentId, this.chainId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Any record this chain's approvals stored, current or not, by its hash. */
  async recordByHash(hash: string): Promise<ProviderApprovalRecord | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM standard_provider_approvals
        WHERE record_hash=$1 AND chain_id=$2 ORDER BY standard_provider_approvals.approval_id LIMIT 1`,
      [bytes(hash), this.chainId],
    );
    return result.rows[0] ? mapRow(result.rows[0])?.record ?? null : null;
  }

  /** The provider's current approval, else its most recent revoked one. */
  async latest(providerAgentId: string): Promise<ProviderApproval | null> {
    const result = await this.pool.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM standard_provider_approvals
        WHERE provider_agent_id=$1 AND chain_id=$2
        ORDER BY revoked_at IS NULL DESC, standard_provider_approvals.approval_id DESC LIMIT 1`,
      [providerAgentId, this.chainId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Every current approval of this chain, from a snapshot at most APPROVAL_SNAPSHOT_TTL_MS old. */
  async currentApprovals(): Promise<ReadonlyMap<string, ProviderApproval>> {
    const snapshot = this.snapshot;
    if (snapshot && snapshot.expiresAt > this.now()) return snapshot.byProvider;
    if (!this.loading) {
      const loading = this.load(this.generation).finally(() => {
        if (this.loading === loading) this.loading = null;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  private async load(generation: number): Promise<Map<string, ProviderApproval>> {
    const previous = this.snapshot;
    try {
      const result = await this.pool.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM standard_provider_approvals
          WHERE chain_id=$1 AND revoked_at IS NULL ORDER BY provider_agent_id`,
        [this.chainId],
      );
      const byProvider = new Map<string, ProviderApproval>();
      for (const row of result.rows) {
        const approval = mapRow(row);
        if (approval) byProvider.set(approval.providerAgentId, approval);
      }
      if (generation !== this.generation) return byProvider;
      const fingerprint = [...byProvider.values()].map((item) => `${item.providerAgentId}:${item.recordHash}`).join(",");
      if (fingerprint !== previous?.fingerprint) this.changes += 1;
      this.snapshot = { expiresAt: this.now() + APPROVAL_SNAPSHOT_TTL_MS, fingerprint, byProvider };
      return byProvider;
    } catch (error) {
      if (!previous || generation !== this.generation) throw error;
      logger.warn("provider approvals could not be read; serving the previous snapshot", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.snapshot = { ...previous, expiresAt: this.now() + APPROVAL_SNAPSHOT_RETRY_MS };
      return previous.byProvider;
    }
  }

  /**
   * Records an approval of one provider. `build` makes the record for an
   * epoch of at least the one it is given, and runs under the provider's lock,
   * so a record never takes an epoch an earlier approval record of the
   * provider holds. A provider holding a current approval keeps it unless
   * `replace` is set; it also keeps it when the record built for the current
   * record's own epoch is that record, so an unchanged provider is never
   * approved anew. Otherwise the current approval is revoked and the new
   * record, one epoch above every earlier one, recorded. The audit row, when
   * given, commits with the outcome.
   */
  async approve(args: {
    providerAgentId: string;
    build: (minimumEpoch: number) => { record: ProviderApprovalRecord; recordHash: Hex };
    approvedBy: string;
    replace: boolean;
    audit?: (outcome: { created: boolean; replaced: ProviderApproval | null; approval: ProviderApproval }) =>
      ProviderApprovalAudit;
  }): Promise<{ approval: ProviderApproval; created: boolean; replaced: ProviderApproval | null }> {
    const { providerAgentId } = args;
    const built = (minimumEpoch: number) => {
      const candidate = args.build(minimumEpoch);
      if (candidate.record.payload.providerAgentId !== providerAgentId) {
        throw new Error("PROVIDER_APPROVAL_PROVIDER_MISMATCH");
      }
      if (candidate.record.chainId !== this.chainId) throw new Error("PROVIDER_APPROVAL_CHAIN_MISMATCH");
      if (canonicalHash(candidate.record) !== candidate.recordHash) throw new Error("PROVIDER_APPROVAL_HASH_MISMATCH");
      return candidate;
    };
    const outcome = await this.transaction(providerAgentId, async (client) => {
      const existing = await client.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM standard_provider_approvals
          WHERE provider_agent_id=$1 AND chain_id=$2 AND revoked_at IS NULL FOR UPDATE`,
        [providerAgentId, this.chainId],
      );
      const current = existing.rows[0] ? mapRow(existing.rows[0]) : null;
      let result: { approval: ProviderApproval; created: boolean; replaced: ProviderApproval | null } | null = null;
      if (current && (!args.replace ||
          built(current.record.payload.servicingProfileEpoch).recordHash === current.recordHash)) {
        result = { approval: current, created: false, replaced: null };
      }
      if (!result) {
        const epochs = await client.query<{ highest: string | null }>(
          `SELECT max((record_json->'payload'->>'servicingProfileEpoch')::bigint)::text AS highest
             FROM standard_provider_approvals WHERE provider_agent_id=$1 AND chain_id=$2`,
          [providerAgentId, this.chainId],
        );
        const candidate = built(Number(epochs.rows[0]?.highest ?? 0) + 1);
        if (existing.rows[0]) {
          await client.query(
            `UPDATE standard_provider_approvals SET revoked_at=now(),revoked_by=$2,updated_at=now()
              WHERE approval_id=$1::bigint`,
            [existing.rows[0].approval_id, args.approvedBy],
          );
        }
        const inserted = await client.query<ApprovalRow>(
          `INSERT INTO standard_provider_approvals
             (provider_agent_id,chain_id,approved_by,record_json,record_hash)
           VALUES ($1,$2,$3,$4,$5) RETURNING ${COLUMNS}`,
          [providerAgentId, this.chainId, args.approvedBy, candidate.record, bytes(candidate.recordHash)],
        );
        const approval = mapRow(inserted.rows[0]!);
        if (!approval) throw new Error("PROVIDER_APPROVAL_HASH_MISMATCH");
        result = { approval, created: true, replaced: current };
      }
      if (args.audit) await this.audit(client, providerAgentId, args.audit(result));
      return result;
    });
    if (outcome.created) this.invalidate();
    return outcome;
  }

  /** Revokes the provider's current approval; null when it holds none. */
  async revoke(args: {
    providerAgentId: string;
    revokedBy: string;
    audit?: (revoked: ProviderApproval) => ProviderApprovalAudit;
  }): Promise<ProviderApproval | null> {
    const revoked = await this.transaction(args.providerAgentId, async (client) => {
      const result = await client.query<ApprovalRow>(
        `UPDATE standard_provider_approvals SET revoked_at=now(),revoked_by=$3,updated_at=now()
          WHERE provider_agent_id=$1 AND chain_id=$2 AND revoked_at IS NULL RETURNING ${COLUMNS}`,
        [args.providerAgentId, this.chainId, args.revokedBy],
      );
      const row = result.rows[0];
      if (!row) return null;
      const approval = mapRow(row) ?? {
        // A corrupt row is still revoked; its record is not served again.
        approvalId: row.approval_id, providerAgentId: row.provider_agent_id, chainId: Number(row.chain_id),
        approvedAt: row.approved_at, approvedBy: row.approved_by, revokedAt: row.revoked_at, revokedBy: row.revoked_by,
        record: row.record_json, recordHash: `0x${row.record_hash.toString("hex")}` as Hex,
      };
      if (args.audit) await this.audit(client, args.providerAgentId, args.audit(approval));
      return approval;
    });
    if (revoked) this.invalidate();
    return revoked;
  }

  private async audit(client: PoolClient, providerAgentId: string, audit: ProviderApprovalAudit): Promise<void> {
    await client.query(
      `INSERT INTO standard_operator_actions (actor,action,target_id,details) VALUES ($1,$2,$3,$4)`,
      [audit.actor, audit.action, providerAgentId, JSON.stringify(audit.details)],
    );
  }

  /** One provider's approval changes are serialized across replicas. */
  private async transaction<T>(providerAgentId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`standard:provider-approval:${this.chainId}:${providerAgentId}`]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
