import { describe, expect, it } from "vitest";
import {
  SessionMetricsRegistry,
  type SessionRollup,
} from "../src/mcp/sessionMetrics.js";

// De-scar 260726 Phase 6: the per-session rollup is the production-side
// replacement for the retired judge loop — the same interaction metrics
// the harness computed, measured on real sessions and emitted as one
// structured log line per session on idle. Describes, never gates.

function registry(nowRef: { t: number }, flushed: SessionRollup[]) {
  return new SessionMetricsRegistry({
    idleFlushMs: 1_000,
    now: () => nowRef.t,
    onFlush: (r) => flushed.push(r),
  });
}

describe("session metrics rollup", () => {
  it("aggregates calls, errors, named codes, and outcome markers per session", () => {
    const now = { t: 1_000 };
    const flushed: SessionRollup[] = [];
    const reg = registry(now, flushed);

    reg.record("s1", "daski_buy_service", false, '{"status":"action-required"}');
    now.t += 100;
    reg.record("s1", "daski_settle_payment", false, '{"status":"completed","paymentId":"42"}');
    reg.record("s1", "daski_get_task_status", true, '{"code":"CAPABILITY_REQUIRED"}');
    reg.record("s1", "daski_confirm_delivery", false, '{"status":"completed","attestationUid":"0xa"}');
    reg.record("s2", "daski_search_services", false, "{}");

    now.t += 2_000;
    expect(reg.sweep()).toBe(2);
    const s1 = flushed.find((r) => r.sessionId === "s1")!;
    expect(s1.toolCalls).toBe(4);
    expect(s1.errors).toBe(1);
    expect(s1.errorCodes).toEqual({ CAPABILITY_REQUIRED: 1 });
    expect(s1.purchasesSettled).toBe(1);
    expect(s1.attestationsSubmitted).toBe(1);
    expect(s1.wallTimeMs).toBe(100);
    expect(s1.toolCallsByName["daski_get_task_status"]).toBe(1);
    const s2 = flushed.find((r) => r.sessionId === "s2")!;
    expect(s2.toolCalls).toBe(1);
  });

  it("keeps active sessions and flushes only idle ones", () => {
    const now = { t: 0 };
    const flushed: SessionRollup[] = [];
    const reg = registry(now, flushed);
    reg.record("old", "daski_search_services", false, "{}");
    now.t = 2_000;
    reg.record("fresh", "daski_search_services", false, "{}");
    expect(reg.sweep()).toBe(1);
    expect(flushed.map((r) => r.sessionId)).toEqual(["old"]);
    // The fresh session flushes once it goes idle too.
    now.t = 10_000;
    expect(reg.sweep()).toBe(1);
  });

  it("buckets sessionless traffic instead of dropping it", () => {
    const now = { t: 0 };
    const flushed: SessionRollup[] = [];
    const reg = registry(now, flushed);
    reg.record(undefined, "daski_search_services", false, "{}");
    reg.flushAll();
    expect(flushed[0]!.sessionId).toBe("sessionless");
  });

  it("an error result with no parseable code still counts as an error", () => {
    const now = { t: 0 };
    const flushed: SessionRollup[] = [];
    const reg = registry(now, flushed);
    reg.record("s", "daski_submit_task", true, "plain text failure");
    reg.record("s", "daski_submit_task", true, null);
    reg.flushAll();
    expect(flushed[0]!.errors).toBe(2);
    expect(flushed[0]!.errorCodes).toEqual({});
  });
});
