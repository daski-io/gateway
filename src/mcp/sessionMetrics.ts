import { logger } from "../util/logger.js";

// ── Per-session telemetry rollup (de-scar 260726, Phase 6) ─────────────────
//
// The launch replacement for the retired per-run judge loop: the same
// interaction metrics the test harness computed (calls, errors, error
// codes, purchases, wall time) measured on REAL sessions, where the agent
// population is diverse and the numbers mean something. One structured
// `mcp.session_metrics` log line per session, emitted when the session
// goes idle — log-based on purpose (Railway already retains structured
// logs; no schema change). Nothing here gates anything: it describes.

export interface SessionRollup {
  sessionId: string;
  startedAt: string;
  wallTimeMs: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  errors: number;
  /** Named error `code`s seen on isError results (parse-best-effort). */
  errorCodes: Record<string, number>;
  /** Canonical-path settles that completed (daski_settle_payment). */
  purchasesSettled: number;
  /** Delivery attestations submitted on-chain (daski_confirm_delivery). */
  attestationsSubmitted: number;
}

interface LiveRollup extends SessionRollup {
  lastActivityAtMs: number;
  startedAtMs: number;
}

const ERROR_CODE = /"code"\s*:\s*"([A-Za-z0-9_-]{1,64})"/;

export interface SessionMetricsOptions {
  /** Idle time after which a session's rollup is flushed. */
  idleFlushMs?: number;
  sweepIntervalMs?: number;
  /** Test seams. */
  now?: () => number;
  onFlush?: (rollup: SessionRollup) => void;
}

export class SessionMetricsRegistry {
  private readonly sessions = new Map<string, LiveRollup>();
  private readonly idleFlushMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly onFlush: (rollup: SessionRollup) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SessionMetricsOptions = {}) {
    this.idleFlushMs = options.idleFlushMs ?? 5 * 60_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.onFlush =
      options.onFlush ??
      ((rollup) => logger.info("mcp.session_metrics", { ...rollup }));
  }

  record(
    sessionId: string | undefined,
    toolName: string,
    isError: boolean,
    resultText: string | null,
  ): void {
    // Sessionless transports (rare: stateless clients) aggregate under one
    // bucket so their traffic is still visible rather than dropped.
    const key = sessionId ?? "sessionless";
    const at = this.now();
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        sessionId: key,
        startedAt: new Date(at).toISOString(),
        startedAtMs: at,
        lastActivityAtMs: at,
        wallTimeMs: 0,
        toolCalls: 0,
        toolCallsByName: {},
        errors: 0,
        errorCodes: {},
        purchasesSettled: 0,
        attestationsSubmitted: 0,
      };
      this.sessions.set(key, s);
    }
    s.lastActivityAtMs = at;
    s.toolCalls++;
    s.toolCallsByName[toolName] = (s.toolCallsByName[toolName] ?? 0) + 1;
    if (isError) {
      s.errors++;
      const code = resultText ? ERROR_CODE.exec(resultText)?.[1] : undefined;
      if (code) s.errorCodes[code] = (s.errorCodes[code] ?? 0) + 1;
    } else if (
      toolName.endsWith("daski_settle_payment") &&
      resultText?.includes('"status":"completed"')
    ) {
      s.purchasesSettled++;
    } else if (
      toolName.endsWith("daski_confirm_delivery") &&
      resultText?.includes('"attestationUid"')
    ) {
      s.attestationsSubmitted++;
    }
  }

  /** Flush every session idle past the threshold. Returns flush count. */
  sweep(): number {
    const cutoff = this.now() - this.idleFlushMs;
    let flushed = 0;
    for (const [key, s] of this.sessions) {
      if (s.lastActivityAtMs > cutoff) continue;
      this.sessions.delete(key);
      this.emit(s);
      flushed++;
    }
    return flushed;
  }

  /** Flush everything immediately (shutdown path). */
  flushAll(): void {
    for (const [key, s] of this.sessions) {
      this.sessions.delete(key);
      this.emit(s);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // Never keep the process alive for telemetry.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(s: LiveRollup): void {
    const { lastActivityAtMs, startedAtMs, ...rollup } = s;
    rollup.wallTimeMs = lastActivityAtMs - startedAtMs;
    this.onFlush(rollup);
  }
}

/** Process-wide registry, fed by instrumentToolCalls. */
export const sessionMetrics = new SessionMetricsRegistry();
