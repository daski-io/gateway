import type { Pool } from "../db/pool.js";
import { logger } from "../util/logger.js";
import { salesPausedError, type StandardRailPhase } from "./errors.js";

export const SALES_OUTAGE_DEFAULT_MINUTES = 10;
export const SALES_OUTAGE_MAX_MINUTES = 60;
const DEFAULT_SET_BY = "catalog-operator";
// The public status is unauthenticated: one shared read per replica a second.
const PUBLIC_STATUS_MEMO_MS = 1_000;

/** The public status contract: `/public/v1/status`, read by the website and its MCP. */
export type SalesStatus =
  | { salesOpen: true }
  | { salesOpen: false; reason: string; since: string; until: string };

export type SalesOutageOperatorState = SalesStatus & { setBy?: string; revision: number };

export interface SalesOutageStart { minutes: number; reason: string; setBy: string }

interface OutageRow {
  paused: boolean;
  reason: string | null;
  since: Date | null;
  until: Date | null;
  set_by: string | null;
  revision: string;
  retry_after: number | null;
}

const READ = `SELECT active AND until>now() AS paused,reason,since,until,set_by,revision::text AS revision,
  GREATEST(1,ceil(extract(epoch FROM until-now())))::int AS retry_after FROM standard_sales_outage`;

function bodyObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_SALES_OUTAGE_REQUEST");
  return raw as Record<string, unknown>;
}

function parseSetBy(value: unknown): string {
  if (value === undefined) return DEFAULT_SET_BY;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,63}$/.test(value)) {
    throw new Error("INVALID_SALES_OUTAGE_REQUEST");
  }
  return value;
}

/** `{minutes?, reason, setBy?}`: minutes is an integer from 1 to 60 (default 10). */
export function parseSalesOutageStart(raw: unknown): SalesOutageStart {
  const body = bodyObject(raw);
  if (Object.keys(body).some((key) => !["minutes", "reason", "setBy"].includes(key))) {
    throw new Error("INVALID_SALES_OUTAGE_REQUEST");
  }
  const minutes = body.minutes ?? SALES_OUTAGE_DEFAULT_MINUTES;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  // The reason is shown publicly: printable text, no control characters.
  if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > SALES_OUTAGE_MAX_MINUTES ||
      !/^[^\p{Cc}\p{Cf}]{1,200}$/u.test(reason)) {
    throw new Error("INVALID_SALES_OUTAGE_REQUEST");
  }
  return { minutes: minutes as number, reason, setBy: parseSetBy(body.setBy) };
}

/** `{setBy?}`, or no body. */
export function parseSalesOutageEnd(raw: unknown): { setBy: string } {
  const body = bodyObject(raw);
  if (Object.keys(body).some((key) => key !== "setBy")) throw new Error("INVALID_SALES_OUTAGE_REQUEST");
  return { setBy: parseSetBy(body.setBy) };
}

function status(row: OutageRow | undefined): SalesStatus {
  if (!row?.paused || !row.reason || !row.since || !row.until) return { salesOpen: true };
  return { salesOpen: false, reason: row.reason, since: row.since.toISOString(), until: row.until.toISOString() };
}

function operatorState(row: OutageRow | undefined): SalesOutageOperatorState {
  const current = status(row);
  return { ...current, ...(!current.salesOpen && row?.set_by ? { setBy: row.set_by } : {}),
    revision: Number(row?.revision ?? 0) };
}

/**
 * The environment's sales outage. The row's end time ends it: nothing runs
 * at expiry, and the database function standard_assert_sale_open() refuses
 * claims and settlement invocations on every replica while it is active.
 */
export class SalesOutage {
  private publicMemo: { expiresAt: number; value: Promise<SalesStatus> } | null = null;

  constructor(private readonly pool: Pool, private readonly environment: string) {}

  private async read(): Promise<OutageRow | undefined> {
    return (await this.pool.query<OutageRow>(READ)).rows[0];
  }

  async status(): Promise<SalesStatus> {
    return status(await this.read());
  }

  async operatorState(): Promise<SalesOutageOperatorState> {
    return operatorState(await this.read());
  }

  /** The status a public reader sees, shared for a second per replica. */
  publicStatus(): Promise<SalesStatus> {
    const now = Date.now();
    if (this.publicMemo && this.publicMemo.expiresAt > now) return this.publicMemo.value;
    const value = this.status();
    const memo = { expiresAt: now + PUBLIC_STATUS_MEMO_MS, value };
    this.publicMemo = memo;
    value.catch(() => { if (this.publicMemo === memo) this.publicMemo = null; });
    return value;
  }

  /** Refuses with SALES_PAUSED while the outage is active. */
  async assertOpen(phase: StandardRailPhase, options: { captured?: boolean } = {}): Promise<void> {
    const row = await this.read();
    const current = status(row);
    if (current.salesOpen) return;
    throw salesPausedError({ ...current, retryAfterSeconds: row?.retry_after ?? 1, phase, captured: options.captured });
  }

  /** Starts an outage, or extends an active one to at least `minutes` from now; never shortens it. */
  async start(request: SalesOutageStart): Promise<SalesOutageOperatorState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<OutageRow>(`${READ} FOR UPDATE`);
      if (!current.rows[0]) throw new Error("SALES_OUTAGE_ROW_MISSING");
      const extending = current.rows[0].paused;
      const updated = await client.query<OutageRow>(`
        UPDATE standard_sales_outage SET active=true,reason=$1,set_by=$2,revision=revision+1,updated_at=now(),
          since=CASE WHEN $3 THEN since ELSE date_trunc('second',now()) END,
          until=CASE WHEN $3 THEN GREATEST(until,date_trunc('second',now())+make_interval(mins=>$4))
            ELSE date_trunc('second',now())+make_interval(mins=>$4) END
        RETURNING true AS paused,reason,since,until,set_by,revision::text AS revision,
          GREATEST(1,ceil(extract(epoch FROM until-now())))::int AS retry_after`,
        [request.reason, request.setBy, extending, request.minutes]);
      const row = updated.rows[0]!;
      await client.query(`INSERT INTO standard_sales_outage_audit
        (revision,action,environment,reason,since,until,previous_until,set_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.revision, extending ? "extend" : "start", this.environment, row.reason, row.since, row.until,
          extending ? current.rows[0].until : null, request.setBy]);
      await client.query("COMMIT");
      this.publicMemo = null;
      logger.warn(extending ? "sales outage extended" : "sales outage started", {
        environment: this.environment, reason: row.reason, since: row.since?.toISOString(),
        until: row.until?.toISOString(), setBy: request.setBy, revision: Number(row.revision),
      });
      return operatorState(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  /** Ends an active outage now; an inactive or expired one is left as it is. */
  async end(request: { setBy: string }): Promise<SalesOutageOperatorState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<OutageRow>(`${READ} FOR UPDATE`);
      const row = current.rows[0];
      if (!row?.paused) {
        await client.query("COMMIT");
        return operatorState(row);
      }
      const ended = await client.query<OutageRow>(`
        UPDATE standard_sales_outage SET active=false,until=LEAST(until,now()),set_by=$1,
          revision=revision+1,updated_at=now()
        RETURNING false AS paused,reason,since,until,set_by,revision::text AS revision,NULL::int AS retry_after`,
        [request.setBy]);
      const endedRow = ended.rows[0]!;
      await client.query(`INSERT INTO standard_sales_outage_audit
        (revision,action,environment,reason,since,until,previous_until,set_by) VALUES($1,'end',$2,$3,$4,$5,$6,$7)`,
        [endedRow.revision, this.environment, row.reason, row.since, endedRow.until, row.until, request.setBy]);
      await client.query("COMMIT");
      this.publicMemo = null;
      logger.warn("sales outage ended", {
        environment: this.environment, reason: row.reason, since: row.since?.toISOString(),
        endedAt: endedRow.until?.toISOString(), plannedUntil: row.until?.toISOString(),
        setBy: request.setBy, revision: Number(endedRow.revision),
      });
      return operatorState(endedRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
